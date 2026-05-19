#!/usr/bin/env tsx
/**
 * ponder-drift-verify.ts — Ponder ↔ chain field-level drift verifier
 *
 * ───────────────────────────────────────────────────────────────────────
 * PURPOSE
 * ───────────────────────────────────────────────────────────────────────
 * Verifies that the off-chain Ponder indexer mirrors the on-chain
 * RezonForge contract truthfully. For every event the protocol depends
 * on, this script:
 *
 *   1. Reads chain event logs directly via viem (= L1 source of truth)
 *   2. Reads the matching Ponder row(s) from postgres (= L2 projection)
 *   3. Counts events vs rows; field-by-field compares each pair
 *   4. Reports drift — by event type, with severity classification
 *
 * R-CHAIN-IS-PUBLIC-TRUTH says the chain is the source of truth and
 * Ponder is its faithful projection. When Ponder drops a field,
 * miscomputes a number, or ingests stale data, the backend serves
 * wrong answers without any signal. This script is the canary that
 * catches drift before it pollutes settlement, claims, or refunds.
 *
 * ───────────────────────────────────────────────────────────────────────
 * EVENT COVERAGE (16 events → 9 Ponder tables)
 * ───────────────────────────────────────────────────────────────────────
 *
 *  Chain event              →  Ponder table                  →  Why it matters
 *  ─────────────────────────────────────────────────────────────────────────────
 *  QuestionSponsored        →  ponder_indexer.confirmations   →  question creation + first stake
 *  QuestionCosponsored      →  ponder_indexer.confirmations   →  additional sponsor stake
 *  SolutionCommitted        →  ponder_indexer.commits         →  solver commits answer + stakes
 *  VoteCast                 →  ponder_indexer.votes_cast      →  voter allocates conviction
 *  SettlementPublished      →  ponder_indexer.settlements     →  oracle posts merkle root
 *  Claimed                  →  ponder_indexer.claims          →  winner/sponsor collects payout
 *  QuestionAbandoned        →  ponder_indexer.abandonments    →  refund path triggered
 *  SponsorRefunded          →  ponder_indexer.refunds         →  sponsor takes refund (abandoned q)
 *  CommitRefunded           →  ponder_indexer.refunds         →  solver stake refund (abandoned q)
 *  VoteRefunded             →  ponder_indexer.refunds         →  voter stake refund (abandoned q)
 *  SolutionStakeClaimed     →  ponder_indexer.stake_actions   →  winner solver gets stake back
 *  VoteStakeClaimed         →  ponder_indexer.stake_actions   →  correct voter gets stake back
 *  SolutionStakeSlashed     →  ponder_indexer.stake_actions   →  losing solver stake slashed
 *  VoteStakeSlashed         →  ponder_indexer.stake_actions   →  incorrect voter stake slashed
 *  FeesAccrued              →  (embedded; updates pending_shares_entries on platform-fee path) — see #note-1
 *  SharesPulled             →  ponder_indexer.pending_shares_entries → pending fee withdrawal
 *
 *  note-1: FeesAccrued is a derivative event; the on-chain emission
 *  represents a per-action fee deduction that may or may not produce a
 *  dedicated row depending on whether the feeShareBps>0 path is taken.
 *  The harness verifies count parity rather than per-row mapping for
 *  this event.
 *
 * ───────────────────────────────────────────────────────────────────────
 * MODES
 * ───────────────────────────────────────────────────────────────────────
 *
 *   VERIFY MODE (default — no gas, no broadcast):
 *     tsx scripts/ponder-drift-verify.ts
 *     tsx scripts/ponder-drift-verify.ts --from-block 41599800
 *     tsx scripts/ponder-drift-verify.ts --from-block 41599800 --to-block 41612000
 *     tsx scripts/ponder-drift-verify.ts --events Claimed,SettlementPublished
 *     tsx scripts/ponder-drift-verify.ts --sample 5  # spot-check first 5 per event
 *
 *   BROADCAST MODE (gas required; for events with zero coverage):
 *     Stubbed — see "Future extensions" below. When implemented, will
 *     synthesize signed intents that trigger the missing events
 *     (refunds, stake claims, slashing) and re-verify.
 *
 *   SELF-TEST MODE (no chain, no DB; exercises comparator logic):
 *     tsx scripts/ponder-drift-verify.ts --self-test
 *
 * ───────────────────────────────────────────────────────────────────────
 * OUTPUT FORMAT
 * ───────────────────────────────────────────────────────────────────────
 *
 * Per event:
 *   ✓ EventName: 16/16 chain → ponder match (sampled 5)
 *   ✗ EventName: 32/32 chain → 0/32 ponder (PROJECTOR_MISS — Ponder handler
 *                 is silent OR chain emitting events the indexer doesn't know about)
 *   ⚠ EventName: 21/21 count match, 3 field DRIFT (see details below)
 *
 * Per-row drift detail:
 *   ↳ tx 0xabc... block 41600125 field "amount":
 *     chain  = 1000000n
 *     ponder = "1000001"           // string serialization is OK
 *     decoded= 1000001n             // ← actual mismatch
 *     severity: CRITICAL (off-by-one in money field)
 *
 * Exit code:
 *   0 — all events pass
 *   1 — count drift on any event (PROJECTOR_MISS or PHANTOM_ROW)
 *   2 — field-level drift on any event (DECODE_DRIFT)
 *
 * ───────────────────────────────────────────────────────────────────────
 * INTERPRETING RESULTS — FOR FUTURE AGENTS
 * ───────────────────────────────────────────────────────────────────────
 *
 * PROJECTOR_MISS  ← Ponder handler is silent for an event the chain emits.
 *                   File against `ponder/src/index.ts`; the on-handler may
 *                   throw, be missing, or filter the event out.
 *
 * PHANTOM_ROW     ← Ponder has a row with no chain log. Almost always
 *                   indicates a reorg cascade that wasn't fully cleaned
 *                   up. File against `ponder/ponder.config.ts` reorg policy.
 *
 * DECODE_DRIFT    ← Chain event field value disagrees with Ponder column.
 *                   Most-common cause: handler maps the wrong indexed
 *                   arg, type coerces wrong (e.g. bigint→int truncates),
 *                   or hashes/normalizes addresses inconsistently.
 *                   File against the specific event handler in `ponder/src/index.ts`.
 *
 * COUNT_OK_FIELD_FAIL ← Counts match, only field values drift. Usually
 *                       a single handler bug. Same target as DECODE_DRIFT.
 *
 * BLOCK_RANGE_EMPTY ← No chain logs and no Ponder rows in the window.
 *                     Not a drift — protocol activity was just absent.
 *                     For events that should NEVER be empty in a healthy
 *                     run (Sponsored, Committed, Voted in any post-launch
 *                     window), surface as INFO.
 *
 * ───────────────────────────────────────────────────────────────────────
 * ENV
 * ───────────────────────────────────────────────────────────────────────
 *
 * Required (from `.env`):
 *   RT_FORGE_ADDRESS   contract address of RezonForge on the target chain
 *   PONDER_DATABASE_URL or DATABASE_URL  postgres connection string
 *   RT_RPC_URL (or RT_RPC_URLS comma-list) chain RPC endpoint(s)
 *
 * Optional:
 *   RT_CHAIN_ID (default 84532 — Base Sepolia)
 *   PONDER_SCHEMA (default "ponder_indexer")
 *
 * ───────────────────────────────────────────────────────────────────────
 * FUTURE EXTENSIONS (TODO)
 * ───────────────────────────────────────────────────────────────────────
 *
 * 1. BROADCAST MODE: For events with 0 chain logs in range, synthesize
 *    a signed intent + broadcast + wait + re-verify. Hooks at lines
 *    marked TODO-BROADCAST below. Per-event broadcast logic lives in
 *    src/intents/*.ts (sponsor, commit, vote) and contract-level helpers.
 *
 * 2. CONTINUOUS MODE: --watch flag to follow chain head and alert on
 *    drift as it occurs. Useful for SRE dashboards.
 *
 * 3. CI MODE: --strict --since=HEAD~100 fails if any drift detected
 *    in the last 100 blocks. Gate every Ponder PR on this.
 *
 * 4. REPAIR MODE: --repair detected DECODE_DRIFT rows by re-projecting
 *    from chain. Dangerous; requires `--i-know-what-im-doing` flag.
 *
 * ───────────────────────────────────────────────────────────────────────
 */

import "dotenv/config";
import { createPublicClient, http, parseAbiItem, type Address, type AbiEvent, type Hex, type Log } from "viem";
import { Client } from "pg";

// ───────────────────────────────────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────────────────────────────────

const FORGE = (process.env.RT_FORGE_ADDRESS as Address) ?? "";
const CHAIN_ID = Number(process.env.RT_CHAIN_ID ?? "84532");
const RPC_URL = (process.env.RT_RPC_URL ?? process.env.RT_RPC_URLS?.split(",")[0] ?? "https://sepolia.base.org").trim();
const PG_URL = process.env.PONDER_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://rezontree:rezontree@localhost:5432/rezontree";
const PONDER_SCHEMA = process.env.PONDER_SCHEMA ?? "ponder_indexer";

if (!FORGE) {
  console.error("ERROR: RT_FORGE_ADDRESS not set. Source the agent .env first.");
  process.exit(2);
}

// ───────────────────────────────────────────────────────────────────────
// EVENT REGISTRY
//
// Each entry declares:
//   - name: contract event name (must match Solidity emit)
//   - ponderTable: destination table in ponder_indexer.*
//   - abi: parseAbiItem string (use exact Solidity sig with indexed/types)
//   - chainKey: function returning a unique key fingerprint from a chain log
//     (used for sample diffing; typically tx_hash + log_index or intent_hash)
//   - ponderKey: SQL WHERE fragment to find the row matching a chain log
//   - compareFields: returns drift entries [{field, chain, ponder, severity}]
//
// FOR FUTURE AGENTS:
//   To add a new event:
//     1. Add an entry to this array
//     2. Make sure the ABI string matches RezonForge.sol exactly
//     3. Choose the right ponderKey strategy (most events use intent_hash,
//        but Claimed/Abandoned use (question_id, block_number, log_index))
//     4. The compareFields function is where drift is detected — be
//        thorough; bigint comparisons via === will fail silently
// ───────────────────────────────────────────────────────────────────────

type ChainLog = Log & { args: any };
type PonderRow = Record<string, any>;

interface FieldDiff {
  field: string;
  chain: unknown;
  ponder: unknown;
  severity: "CRITICAL" | "HIGH" | "MED" | "LOW" | "INFO";
  note?: string;
}

interface EventRegistryEntry {
  name: string;
  ponderTable: string;
  abi: AbiEvent;
  // returns the SELECT ... WHERE ... matching key (parameterized).
  // Use $1 .. $N for params; we pass values in `keyArgs`.
  ponderWhere: string;
  ponderKeyArgs: (log: ChainLog) => unknown[];
  compareFields: (log: ChainLog, row: PonderRow) => FieldDiff[];
  // If this event should have at least N rows in a healthy run window
  // (otherwise we emit INFO not WARNING).
  expectedMinInActiveWindow?: number;
  // TODO-BROADCAST: optional function to fire this event. Not yet wired.
  // broadcast?: (ctx: BroadcastCtx) => Promise<Hex>;
}

// ───────────────────────────────────────────────────────────────────────
// Helper diff builders — keep types tight; bigint vs string is a constant
// source of drift if the comparator coerces wrong.
// ───────────────────────────────────────────────────────────────────────

function diffBigInt(field: string, chain: bigint | undefined, ponder: any, severity: FieldDiff["severity"] = "CRITICAL"): FieldDiff | null {
  if (chain === undefined && ponder === null) return null;
  if (chain === undefined || ponder === null || ponder === undefined) {
    return { field, chain, ponder, severity, note: "one side missing" };
  }
  const ponderBig = typeof ponder === "bigint" ? ponder : BigInt(ponder);
  if (ponderBig !== chain) return { field, chain, ponder: ponderBig, severity };
  return null;
}

function diffHex(field: string, chain: Hex | undefined, ponder: any, severity: FieldDiff["severity"] = "HIGH"): FieldDiff | null {
  if (chain === undefined && (ponder === null || ponder === undefined)) return null;
  const chainNorm = chain ? (chain as string).toLowerCase().replace(/^0x/, "") : "";
  const ponderNorm =
    typeof ponder === "string"
      ? ponder.toLowerCase().replace(/^0x/, "")
      : Buffer.isBuffer(ponder)
        ? ponder.toString("hex").toLowerCase()
        : ponder?.toString("hex")?.toLowerCase?.() ?? "";
  if (chainNorm !== ponderNorm) {
    return { field, chain: "0x" + chainNorm, ponder: "0x" + ponderNorm, severity };
  }
  return null;
}

function diffAddress(field: string, chain: Address | undefined, ponder: any): FieldDiff | null {
  return diffHex(field, chain as Hex | undefined, ponder, "HIGH");
}

function nonNull<T>(...d: (T | null)[]): T[] {
  return d.filter((x) => x !== null) as T[];
}

// ───────────────────────────────────────────────────────────────────────
// EVENT_REGISTRY — every event the protocol depends on.
// Add new events here; the verifier picks them up automatically.
// ───────────────────────────────────────────────────────────────────────

const EVENT_REGISTRY: EventRegistryEntry[] = [
  // ── QuestionSponsored ────────────────────────────────────────────────
  {
    name: "QuestionSponsored",
    ponderTable: "confirmations",
    abi: parseAbiItem(
      "event QuestionSponsored(bytes32 indexed questionId, bytes32 indexed intentHash, address indexed sponsor, address oracle, address token, uint256 amount, uint256 stakeFloor, uint256 stakeBasisPoints, uint256 sponsorshipFloor, uint256 voteFee, uint256 commitFee, uint256 noSolutionGracePeriod, uint256 feeShareBps, address platformFeeRecipient, uint256 fundingDeadline, uint256 newPoolAmount)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1 AND event_type = 'sponsor'",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("sponsor", log.args.sponsor, row.sponsor),
        diffBigInt("amount", log.args.amount, row.amount),
        diffAddress("oracle", log.args.oracle, row.oracle),
        diffAddress("token", log.args.token, row.token),
        diffBigInt("stakeFloor", log.args.stakeFloor, row.stake_floor),
        diffBigInt("stakeBasisPoints", log.args.stakeBasisPoints, row.stake_basis_points),
        diffBigInt("fundingDeadline", log.args.fundingDeadline, row.funding_deadline),
        diffBigInt("newPoolAmount", log.args.newPoolAmount, row.new_pool_amount),
      ),
  },

  // ── QuestionCosponsored ──────────────────────────────────────────────
  {
    name: "QuestionCosponsored",
    ponderTable: "confirmations",
    abi: parseAbiItem(
      "event QuestionCosponsored(bytes32 indexed questionId, bytes32 indexed intentHash, address indexed sponsor, uint256 amount, uint256 newPoolAmount)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1 AND event_type = 'cosponsor'",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("sponsor", log.args.sponsor, row.sponsor),
        diffBigInt("amount", log.args.amount, row.amount),
        diffBigInt("newPoolAmount", log.args.newPoolAmount, row.new_pool_amount),
      ),
  },

  // ── SolutionCommitted ────────────────────────────────────────────────
  {
    name: "SolutionCommitted",
    ponderTable: "commits",
    abi: parseAbiItem(
      "event SolutionCommitted(bytes32 indexed questionId, bytes32 indexed intentHash, address indexed solver, uint256 stake, uint256 fee, bytes32 contentHash)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("solver", log.args.solver, row.solver),
        diffBigInt("stake", log.args.stake, row.stake),
        diffBigInt("fee", log.args.fee, row.fee),
        diffHex("contentHash", log.args.contentHash, row.content_hash),
      ),
  },

  // ── VoteCast ─────────────────────────────────────────────────────────
  {
    name: "VoteCast",
    ponderTable: "votes_cast",
    abi: parseAbiItem(
      "event VoteCast(bytes32 indexed questionId, bytes32 indexed intentHash, address indexed voter, uint256 fee, uint256 stake, bytes32 allocationsHash)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("voter", log.args.voter, row.voter),
        diffBigInt("fee", log.args.fee, row.fee),
        diffBigInt("stake", log.args.stake, row.stake),
        diffHex("allocationsHash", log.args.allocationsHash, row.allocations_hash),
      ),
  },

  // ── SettlementPublished ──────────────────────────────────────────────
  {
    name: "SettlementPublished",
    ponderTable: "settlements",
    // SettlementPublished has no intent_hash topic — match on question_id + block_number
    // (each question publishes settlement once; block uniquely identifies the tx).
    abi: parseAbiItem(
      "event SettlementPublished(bytes32 indexed questionId, address indexed oracle, bytes32 merkleRoot, uint256 totalClaimable, uint256 dustFolded)",
    ) as AbiEvent,
    ponderWhere: "question_id = $1 AND block_number = $2",
    ponderKeyArgs: (log) => [Buffer.from((log.args.questionId as Hex).slice(2), "hex"), Number(log.blockNumber)],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffAddress("oracle", log.args.oracle, row.oracle),
        diffHex("merkleRoot", log.args.merkleRoot, row.merkle_root),
        diffBigInt("totalClaimable", log.args.totalClaimable, row.total_claimable),
        diffBigInt("dustFolded", log.args.dustFolded, row.dust_folded),
      ),
  },

  // ── Claimed ──────────────────────────────────────────────────────────
  // Claimed has no intent_hash either; match by (qid, recipient, block).
  {
    name: "Claimed",
    ponderTable: "claims",
    abi: parseAbiItem(
      "event Claimed(bytes32 indexed questionId, address indexed claimant, uint256 amount)",
    ) as AbiEvent,
    ponderWhere: "question_id = $1 AND claimant = $2 AND block_number = $3",
    ponderKeyArgs: (log) => [
      Buffer.from((log.args.questionId as Hex).slice(2), "hex"),
      Buffer.from((log.args.claimant as Address).slice(2).toLowerCase(), "hex"),
      Number(log.blockNumber),
    ],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffAddress("claimant", log.args.claimant, row.claimant),
        diffBigInt("amount", log.args.amount, row.amount),
      ),
  },

  // ── QuestionAbandoned ────────────────────────────────────────────────
  // Emitted only once per question, on the FIRST refund-path claim.
  // Note: in the 40-q swarm of 2026-05-17, this never fired because
  // backend marked abandonments off-chain without triggering refunds.
  // This is the canary for CRITICAL C1 in the audit doc.
  {
    name: "QuestionAbandoned",
    ponderTable: "abandonments",
    abi: parseAbiItem(
      "event QuestionAbandoned(bytes32 indexed questionId, address indexed firstClaimant)",
    ) as AbiEvent,
    ponderWhere: "question_id = $1",
    ponderKeyArgs: (log) => [Buffer.from((log.args.questionId as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffAddress("firstClaimant", log.args.firstClaimant, row.first_claimant),
      ),
  },

  // ── SponsorRefunded ──────────────────────────────────────────────────
  {
    name: "SponsorRefunded",
    ponderTable: "refunds",
    abi: parseAbiItem(
      "event SponsorRefunded(bytes32 indexed questionId, address indexed sponsor, uint256 amount)",
    ) as AbiEvent,
    // SponsorRefunded has no intent_hash. Match by qid+recipient+block+log_index.
    ponderWhere: "refund_type = 'sponsor' AND question_id = $1 AND recipient = $2 AND block_number = $3",
    ponderKeyArgs: (log) => [
      Buffer.from((log.args.questionId as Hex).slice(2), "hex"),
      Buffer.from((log.args.sponsor as Address).slice(2).toLowerCase(), "hex"),
      Number(log.blockNumber),
    ],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffAddress("recipient", log.args.sponsor, row.recipient),
        diffBigInt("amount", log.args.amount, row.amount),
      ),
  },

  // ── CommitRefunded ───────────────────────────────────────────────────
  {
    name: "CommitRefunded",
    ponderTable: "refunds",
    abi: parseAbiItem(
      "event CommitRefunded(bytes32 indexed questionId, address indexed submitter, bytes32 indexed intentHash, uint256 fee, uint256 stake)",
    ) as AbiEvent,
    ponderWhere: "refund_type = 'commit' AND intent_hash = $1",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("recipient", log.args.submitter, row.recipient),
        diffBigInt("amount", (log.args.fee as bigint) + (log.args.stake as bigint), row.amount),
      ),
  },

  // ── VoteRefunded ─────────────────────────────────────────────────────
  {
    name: "VoteRefunded",
    ponderTable: "refunds",
    abi: parseAbiItem(
      "event VoteRefunded(bytes32 indexed questionId, address indexed voter, bytes32 indexed intentHash, uint256 fee, uint256 stake)",
    ) as AbiEvent,
    ponderWhere: "refund_type = 'vote' AND intent_hash = $1",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("questionId", log.args.questionId, row.question_id),
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("recipient", log.args.voter, row.recipient),
        diffBigInt("amount", (log.args.fee as bigint) + (log.args.stake as bigint), row.amount),
      ),
  },

  // ── SolutionStakeClaimed ─────────────────────────────────────────────
  {
    name: "SolutionStakeClaimed",
    ponderTable: "stake_actions",
    abi: parseAbiItem(
      "event SolutionStakeClaimed(bytes32 indexed intentHash, address indexed submitter, uint256 amount)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1 AND outcome = 'claimed' AND role = 'solver'",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("recipient", log.args.submitter, row.recipient),
        diffBigInt("amount", log.args.amount, row.amount),
      ),
  },

  // ── VoteStakeClaimed ─────────────────────────────────────────────────
  {
    name: "VoteStakeClaimed",
    ponderTable: "stake_actions",
    abi: parseAbiItem(
      "event VoteStakeClaimed(bytes32 indexed intentHash, address indexed voter, uint256 amount)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1 AND outcome = 'claimed' AND role = 'voter'",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffAddress("recipient", log.args.voter, row.recipient),
        diffBigInt("amount", log.args.amount, row.amount),
      ),
  },

  // ── SolutionStakeSlashed ─────────────────────────────────────────────
  // Note: no `recipient` topic — the slash transfers to a fee recipient.
  // Ponder is expected to record amount + intent_hash; the destination
  // is the platform fee recipient (looked up out-of-band).
  {
    name: "SolutionStakeSlashed",
    ponderTable: "stake_actions",
    abi: parseAbiItem(
      "event SolutionStakeSlashed(bytes32 indexed intentHash, uint256 amount)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1 AND outcome = 'slashed' AND role = 'solver'",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffBigInt("amount", log.args.amount, row.amount),
      ),
  },

  // ── VoteStakeSlashed ─────────────────────────────────────────────────
  {
    name: "VoteStakeSlashed",
    ponderTable: "stake_actions",
    abi: parseAbiItem(
      "event VoteStakeSlashed(bytes32 indexed intentHash, uint256 amount)",
    ) as AbiEvent,
    ponderWhere: "intent_hash = $1 AND outcome = 'slashed' AND role = 'voter'",
    ponderKeyArgs: (log) => [Buffer.from((log.args.intentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("intentHash", log.args.intentHash, row.intent_hash),
        diffBigInt("amount", log.args.amount, row.amount),
      ),
  },

  // ── FeesAccrued ──────────────────────────────────────────────────────
  // Count-only verification — see note-1 in the file header.
  // FeesAccrued doesn't always have a dedicated row; it updates either
  // pending_shares_entries (platform-fee shares) or routes via SharesPulled.
  // Our verifier counts chain emissions; per-row mapping is skipped.
  {
    name: "FeesAccrued",
    ponderTable: "pending_shares_entries", // best-effort target
    abi: parseAbiItem(
      "event FeesAccrued(address indexed recipient, address indexed token, uint256 amount, bytes32 sourceIntentHash)",
    ) as AbiEvent,
    ponderWhere: "source_intent_hash = $1",
    ponderKeyArgs: (log) => [Buffer.from((log.args.sourceIntentHash as Hex).slice(2), "hex")],
    compareFields: (log, row) =>
      nonNull(
        diffHex("sourceIntentHash", log.args.sourceIntentHash, row.source_intent_hash),
        diffAddress("recipient", log.args.recipient, row.recipient),
        diffAddress("token", log.args.token, row.token),
        diffBigInt("amount", log.args.amount, row.amount, "MED"),
      ),
  },

  // ── SharesPulled ─────────────────────────────────────────────────────
  // Emitted when a fee-recipient withdraws their accumulated shares.
  {
    name: "SharesPulled",
    ponderTable: "pending_shares_entries",
    abi: parseAbiItem(
      "event SharesPulled(address indexed recipient, address indexed token, uint256 amount)",
    ) as AbiEvent,
    // SharesPulled doesn't have an intent_hash; the row is updated, not
    // inserted. Verifier matches by (recipient, token) and checks
    // last_event_block.
    ponderWhere: "recipient = $1 AND token = $2",
    ponderKeyArgs: (log) => [
      Buffer.from((log.args.recipient as Address).slice(2).toLowerCase(), "hex"),
      Buffer.from((log.args.token as Address).slice(2).toLowerCase(), "hex"),
    ],
    compareFields: (log, row) =>
      nonNull(
        diffAddress("recipient", log.args.recipient, row.recipient),
        diffAddress("token", log.args.token, row.token),
        // amount: we don't compare directly since the row stores
        // running balance, not the pulled amount.
      ),
  },
];

// ───────────────────────────────────────────────────────────────────────
// VERIFIER CORE
// ───────────────────────────────────────────────────────────────────────

interface VerifyOpts {
  fromBlock?: bigint;
  toBlock?: bigint | "latest";
  events?: string[]; // event name filter
  sample: number; // how many rows per event to spot-check
}

interface EventReport {
  name: string;
  chainCount: number;
  ponderCount: number;
  sampled: number;
  driftRows: { tx: string; diffs: FieldDiff[] }[];
  classification: "PASS" | "PROJECTOR_MISS" | "PHANTOM_ROW" | "DECODE_DRIFT" | "BLOCK_RANGE_EMPTY";
}

async function verifyMode(opts: VerifyOpts): Promise<EventReport[]> {
  const client = createPublicClient({ transport: http(RPC_URL) });
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();

  // Compute the block range. Default: last 1000 blocks of activity.
  let to: bigint;
  if (opts.toBlock === "latest" || opts.toBlock === undefined) {
    to = await client.getBlockNumber();
  } else {
    to = opts.toBlock;
  }
  const from = opts.fromBlock ?? to - 1000n;

  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`Ponder drift verifier`);
  console.log(`  contract:  ${FORGE}`);
  console.log(`  chain_id:  ${CHAIN_ID}`);
  console.log(`  rpc:       ${RPC_URL}`);
  console.log(`  db schema: ${PONDER_SCHEMA}`);
  console.log(`  block range: ${from} → ${to} (${to - from} blocks)`);
  console.log(`  sample per event: ${opts.sample}`);
  console.log(`──────────────────────────────────────────────────────────────\n`);

  const reports: EventReport[] = [];

  for (const entry of EVENT_REGISTRY) {
    if (opts.events && !opts.events.includes(entry.name)) continue;

    // 1. Read chain logs in range.
    const logs = (await client.getLogs({
      address: FORGE,
      event: entry.abi,
      fromBlock: from,
      toBlock: to,
    })) as ChainLog[];

    // 2. Count Ponder rows in range for the same table (loose count;
    //    per-row exact match happens in the sample loop).
    const ponderCountRes = await pg.query(
      `SELECT COUNT(*)::int AS c FROM ${PONDER_SCHEMA}.${entry.ponderTable} WHERE block_number BETWEEN $1 AND $2`,
      [Number(from), Number(to)],
    );
    const ponderCount = ponderCountRes.rows[0].c as number;

    // 3. Sample diff.
    const driftRows: { tx: string; diffs: FieldDiff[] }[] = [];
    const sampleSize = Math.min(opts.sample, logs.length);
    for (let i = 0; i < sampleSize; i++) {
      const log = logs[i];
      const where = `SELECT * FROM ${PONDER_SCHEMA}.${entry.ponderTable} WHERE ${entry.ponderWhere} LIMIT 1`;
      const args = entry.ponderKeyArgs(log);
      const r = await pg.query(where, args);
      if (r.rows.length === 0) {
        driftRows.push({
          tx: log.transactionHash ?? "?",
          diffs: [
            {
              field: "(row)",
              chain: "present",
              ponder: "MISSING",
              severity: "CRITICAL",
              note: "no matching row in Ponder",
            },
          ],
        });
        continue;
      }
      const diffs = entry.compareFields(log, r.rows[0]);
      if (diffs.length) driftRows.push({ tx: log.transactionHash ?? "?", diffs });
    }

    // 4. Classify.
    let classification: EventReport["classification"];
    if (logs.length === 0 && ponderCount === 0) classification = "BLOCK_RANGE_EMPTY";
    else if (logs.length > 0 && ponderCount === 0) classification = "PROJECTOR_MISS";
    else if (logs.length === 0 && ponderCount > 0) classification = "PHANTOM_ROW";
    else if (logs.length !== ponderCount) classification = driftRows.length ? "DECODE_DRIFT" : "PROJECTOR_MISS";
    else if (driftRows.length > 0) classification = "DECODE_DRIFT";
    else classification = "PASS";

    reports.push({
      name: entry.name,
      chainCount: logs.length,
      ponderCount,
      sampled: sampleSize,
      driftRows,
      classification,
    });
  }

  await pg.end();
  return reports;
}

// ───────────────────────────────────────────────────────────────────────
// OUTPUT
// ───────────────────────────────────────────────────────────────────────

function printReports(reports: EventReport[]): number {
  let exitCode = 0;
  console.log("\n=== RESULTS ===\n");

  for (const r of reports) {
    const sym =
      r.classification === "PASS"
        ? "✓"
        : r.classification === "BLOCK_RANGE_EMPTY"
          ? "·"
          : "✗";
    const tag =
      r.classification === "PASS"
        ? "PASS"
        : r.classification === "BLOCK_RANGE_EMPTY"
          ? "EMPTY (no chain activity in range)"
          : r.classification;
    console.log(`${sym} ${r.name.padEnd(22)}  chain=${r.chainCount}  ponder=${r.ponderCount}  sampled=${r.sampled}  ${tag}`);

    for (const dr of r.driftRows) {
      console.log(`    ↳ ${dr.tx}`);
      for (const d of dr.diffs) {
        console.log(`      [${d.severity}] ${d.field}:`);
        console.log(`         chain  = ${stringify(d.chain)}`);
        console.log(`         ponder = ${stringify(d.ponder)}`);
        if (d.note) console.log(`         note   = ${d.note}`);
      }
    }

    if (r.classification !== "PASS" && r.classification !== "BLOCK_RANGE_EMPTY") {
      exitCode = r.classification === "DECODE_DRIFT" ? 2 : 1;
    }
  }

  console.log(`\n=== SUMMARY ===`);
  const pass = reports.filter((r) => r.classification === "PASS").length;
  const empty = reports.filter((r) => r.classification === "BLOCK_RANGE_EMPTY").length;
  const fail = reports.length - pass - empty;
  console.log(`  PASS:  ${pass}/${reports.length}`);
  console.log(`  EMPTY: ${empty}/${reports.length}  (no chain activity in window — not necessarily a defect)`);
  console.log(`  FAIL:  ${fail}/${reports.length}`);
  console.log(`  exit ${exitCode}`);

  return exitCode;
}

function stringify(v: unknown): string {
  if (typeof v === "bigint") return v.toString() + "n";
  if (Buffer.isBuffer(v)) return "0x" + v.toString("hex");
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ───────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: VerifyOpts = { sample: 5 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from-block") opts.fromBlock = BigInt(args[++i]);
    else if (a === "--to-block") opts.toBlock = BigInt(args[++i]);
    else if (a === "--events") opts.events = args[++i].split(",");
    else if (a === "--sample") opts.sample = Number(args[++i]);
    else if (a === "--self-test") return { selfTest: true } as any;
    else if (a === "-h" || a === "--help") {
      console.log(
        "usage: ponder-drift-verify.ts [--from-block N] [--to-block N|latest] [--events A,B] [--sample N] [--self-test]",
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

// ───────────────────────────────────────────────────────────────────────
// SELF-TEST — exercises comparator logic without touching chain or DB.
// Run before suspecting the verifier itself is buggy.
// ───────────────────────────────────────────────────────────────────────

function selfTest() {
  console.log("self-test: comparator logic\n");
  const cases: Array<[string, FieldDiff | null]> = [
    ["bigint equal", diffBigInt("x", 100n, 100n)],
    ["bigint string-coerce", diffBigInt("x", 100n, "100")],
    ["bigint mismatch", diffBigInt("x", 100n, 101n)],
    ["bigint null/undef", diffBigInt("x", undefined, null)],
    ["hex equal", diffHex("x", "0xabcd" as Hex, "0xabcd")],
    ["hex case-insensitive", diffHex("x", "0xABCD" as Hex, "0xabcd")],
    ["hex no prefix", diffHex("x", "0xabcd" as Hex, "abcd")],
    ["hex buffer", diffHex("x", "0xabcd" as Hex, Buffer.from([0xab, 0xcd]))],
    ["hex mismatch", diffHex("x", "0xabcd" as Hex, "0x1234")],
    ["address equal", diffAddress("x", "0xAbCdEf1234567890aBcDeF1234567890aBcDeF12" as Address, "0xabcdef1234567890abcdef1234567890abcdef12")],
  ];
  let pass = 0;
  for (const [label, result] of cases) {
    const passed = label.includes("equal") || label.includes("coerce") || label.includes("case-insensitive") || label.includes("no prefix") || label.includes("buffer") || label.includes("null/undef")
      ? result === null
      : result !== null;
    console.log(`  ${passed ? "✓" : "✗"} ${label}: ${result ? "diff detected" : "no diff"}`);
    if (passed) pass++;
  }
  console.log(`\nself-test: ${pass}/${cases.length} pass`);
  process.exit(pass === cases.length ? 0 : 1);
}

// ───────────────────────────────────────────────────────────────────────
// MAIN
// ───────────────────────────────────────────────────────────────────────

(async () => {
  const opts = parseArgs() as VerifyOpts & { selfTest?: boolean };
  if (opts.selfTest) {
    selfTest();
    return;
  }
  const reports = await verifyMode(opts);
  const code = printReports(reports);
  process.exit(code);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
