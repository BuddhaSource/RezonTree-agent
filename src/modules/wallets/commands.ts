// modules/wallets/commands.ts — CLI surface for the wallets module.
//
// `manage wallets <subcommand>` — register, import, list, deactivate,
// set-role, set-topic.

import type { Command } from "commander";
import {
  registerWallet,
  listWallets,
  deactivateWallet,
  setRole,
  setTopicInterest,
  getWallet,
  getRoles,
  loadAccount,
} from "./service.js";
import {
  applyReferralCode,
  resolveReferralCode,
  getMyReferralCode,
  claimMyReferralCode,
  upgradeMyReferralCode,
  type MyReferralCodeResult,
} from "./referral.js";
import { getLogger } from "../../core/logger.js";

const log = getLogger("wallets.cli");

export function registerWalletsCommands(program: Command): void {
  const wallets = program
    .command("wallets")
    .description("Manage agent wallets (the atomic identity).");

  wallets
    .command("register")
    .description("Register a new wallet via a provider.")
    .requiredOption(
      "--provider <type>",
      "Provider type: hd | imported | privy",
    )
    .option("--alias <name>", "Optional human label.")
    .option(
      "--hd-index <n>",
      "For hd provider: BIP-44 address index.",
      (v) => Number.parseInt(v, 10),
    )
    .option(
      "--private-key <hex>",
      "For imported provider: 0x-prefixed 32-byte hex.",
    )
    .option(
      "--key-env-var <name>",
      "For imported provider: env var name where the key lives at runtime.",
    )
    .option("--privy-user-id <id>", "For privy provider.")
    .option("--embedded-wallet-id <id>", "For privy provider.")
    .option("--address <0x>", "For privy provider: known wallet address.")
    .option(
      "--referral-code <code>",
      "Optional. Bind this wallet to a 5-char [a-z0-9] referral code on the backend (best-effort). Falls back to REZONTREE_REFERRAL_CODE env var. Must be set within 24h of wallet creation on the backend.",
    )
    .action(async (opts) => {
      const details: Record<string, unknown> = {};
      if (opts.hdIndex !== undefined) details.hd_index = opts.hdIndex;
      if (opts.privateKey) details.private_key = opts.privateKey;
      if (opts.keyEnvVar) details.key_env_var = opts.keyEnvVar;
      if (opts.privyUserId) details.privy_user_id = opts.privyUserId;
      if (opts.embeddedWalletId) details.embedded_wallet_id = opts.embeddedWalletId;
      if (opts.address) details.address = opts.address;

      const w = await registerWallet({
        providerType: opts.provider,
        alias: opts.alias,
        details,
      });

      // Best-effort: attempt to bind this wallet to a referrer on the
      // backend. Surfaces as a `referral` field on the CLI output;
      // failure does NOT roll back the local wallet registration.
      const referralResult = await maybeApplyReferral(w.address, opts.referralCode);
      console.log(
        JSON.stringify(
          referralResult === null
            ? { ok: true, wallet: w }
            : { ok: true, wallet: w, referral: referralResult },
          null,
          2,
        ),
      );
    });

  wallets
    .command("list")
    .description("List wallets on the current network.")
    .option("--all", "Include deactivated wallets.")
    .action(async (opts) => {
      const rows = await listWallets({ activeOnly: !opts.all });
      console.log(JSON.stringify(rows, null, 2));
    });

  wallets
    .command("show <address>")
    .description("Show details + roles for one wallet.")
    .action(async (address: string) => {
      const w = await getWallet(address);
      if (!w) {
        console.error(`No wallet found: ${address}`);
        process.exit(1);
      }
      const roles = await getRoles(address);
      console.log(JSON.stringify({ wallet: w, roles }, null, 2));
    });

  wallets
    .command("deactivate <address>")
    .description("Mark a wallet inactive (soft delete).")
    .action(async (address: string) => {
      await deactivateWallet(address);
      console.log(JSON.stringify({ ok: true, address }, null, 2));
    });

  wallets
    .command("set-role")
    .description("Enable/disable a role for a wallet.")
    .requiredOption("--address <0x>")
    .requiredOption("--role <name>", "sponsor | resolver | voter")
    .option("--disable", "Disable instead of enabling.")
    .option(
      "--budget <usd>",
      "Daily budget in USD for this role.",
      (v) => Number.parseFloat(v),
    )
    .action(async (opts) => {
      await setRole({
        address: opts.address,
        role: opts.role,
        enabled: !opts.disable,
        dailyBudgetUsd: opts.budget,
      });
      console.log(JSON.stringify({ ok: true }, null, 2));
    });

  // ── referral-code: claim / show / upgrade YOUR OWN referral code ────
  //
  // Affiliate-side. Lets the operator inspect or claim the code that
  // OTHERS will use to credit this wallet as their referrer. The
  // earlier `--referral-code` flag on `wallets register` is the
  // referee-side equivalent (binding YOUR wallet to someone ELSE's
  // code).
  const referralCode = wallets
    .command("referral-code")
    .description("Manage this wallet's own referral code (the code others use to credit it).");

  // --address default: when omitted, resolve to the single active
  // wallet in the local DB. Errors if zero or multiple active wallets.
  // Audit-fix M4 — single-wallet operators no longer need to copy-paste
  // the address every time.
  const addressFlagDoc =
    "Wallet address. If omitted and exactly one wallet is active in the local DB, that one is used.";

  referralCode
    .command("show")
    .description("Show the current referral code for a wallet (GET /v1/me/referral-code).")
    .option("--address <0x>", addressFlagDoc)
    .action(async (opts) => {
      const address = await resolveAddress(opts.address);
      if (address === null) return;
      const result = await runReferralCodeOp(address, (ctx) =>
        getMyReferralCode(ctx),
      );
      printReferralCodeResult(result);
    });

  referralCode
    .command("claim")
    .description(
      "Get-or-create this wallet's referral code (POST /v1/me/referral-code). Idempotent.",
    )
    .option("--address <0x>", addressFlagDoc)
    .option(
      "--desired <code>",
      "Optional 5-char [a-z0-9] code to claim. Omit to auto-generate.",
    )
    .action(async (opts) => {
      const address = await resolveAddress(opts.address);
      if (address === null) return;
      const result = await runReferralCodeOp(address, (ctx) =>
        claimMyReferralCode({ ...ctx, desiredCode: opts.desired }),
      );
      printReferralCodeResult(result);
    });

  referralCode
    .command("upgrade")
    .description(
      "Replace an auto-generated code with a chosen one (PATCH /v1/me/referral-code). One-shot.",
    )
    .option("--address <0x>", addressFlagDoc)
    .requiredOption(
      "--desired <code>",
      "The new 5-char [a-z0-9] code to claim.",
    )
    .action(async (opts) => {
      const address = await resolveAddress(opts.address);
      if (address === null) return;
      const result = await runReferralCodeOp(address, (ctx) =>
        upgradeMyReferralCode({ ...ctx, desiredCode: opts.desired }),
      );
      printReferralCodeResult(result);
    });

  wallets
    .command("set-topic")
    .description("Set/update a wallet's interest weight in a topic.")
    .requiredOption("--address <0x>")
    .requiredOption("--topic <id>", "Topic ID, e.g. biology, biology.molecular")
    .option(
      "--weight <n>",
      "Interest weight (default 1.0).",
      (v) => Number.parseFloat(v),
    )
    .action(async (opts) => {
      await setTopicInterest({
        address: opts.address,
        topicId: opts.topic,
        weight: opts.weight,
      });
      console.log(JSON.stringify({ ok: true }, null, 2));
    });
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * maybeApplyReferral binds the freshly-registered wallet to a referrer
 * on the backend, if a referral code was supplied via CLI flag or the
 * REZONTREE_REFERRAL_CODE env var. Best-effort: failures are logged at
 * warn and returned as a structured `referral` field in the CLI output,
 * but never abort the parent wallet-register command.
 *
 * Returns:
 *   - null         — no referral code provided; no attempt made.
 *   - { ok: true } — backend bound the referrer successfully.
 *   - { ok: false, code, message, action? } — attempt failed; structured
 *     detail surfaced to the operator. Common codes:
 *       REFERRAL_CODE_INVALID_FORMAT, REFERRAL_CODE_NOT_FOUND,
 *       REFERRER_SELF, REFERRER_ALREADY_SET, REFERRAL_GRACE_EXPIRED.
 */
async function maybeApplyReferral(
  walletAddress: string,
  cliFlag: string | undefined,
): Promise<
  | null
  | { ok: true; referrer_wallet: string; set_at: number; grace_expires_at: number }
  | { ok: false; code: string; message: string; action?: string }
> {
  const code = resolveReferralCode(cliFlag);
  if (!code) return null;

  const backendUrl =
    process.env.RT_AGENT_BACKEND_URL ||
    process.env.REZONTREE_API_URL ||
    "http://localhost:8080";

  let account;
  try {
    account = await loadAccount(walletAddress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, code }, "referral: could not load signing account");
    return {
      ok: false,
      code: "ACCOUNT_LOAD_FAILED",
      message: `Could not load signing account for ${walletAddress}: ${msg}`,
    };
  }

  const result = await applyReferralCode({ account, code, backendUrl });
  if (result.ok) {
    log.info(
      {
        wallet: walletAddress,
        code,
        referrer: result.referrerWallet,
        setAt: result.setAt,
      },
      "referral: bound successfully",
    );
    return {
      ok: true,
      referrer_wallet: result.referrerWallet,
      set_at: result.setAt,
      grace_expires_at: result.graceExpiresAt,
    };
  }

  log.warn(
    {
      wallet: walletAddress,
      code,
      backendCode: result.code,
      message: result.message,
    },
    "referral: backend rejected (wallet registration was not affected)",
  );
  return {
    ok: false,
    code: result.code,
    message: result.message,
    action: result.action,
  };
}

/**
 * resolveAddress returns the explicit --address flag if supplied,
 * or falls back to the single active wallet in the local DB. Errors
 * to stderr + process.exit(1) on zero/multiple active wallets so the
 * operator gets an actionable hint without burning a sign + auth.
 *
 * Returns `null` when an error has already been printed + exit
 * scheduled — callers `if (address === null) return` to bail.
 */
async function resolveAddress(explicit: string | undefined): Promise<string | null> {
  if (explicit) return explicit;

  let rows;
  try {
    rows = await listWallets({ activeOnly: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify(
        {
          ok: false,
          code: "WALLET_LIST_FAILED",
          message: `Could not list local wallets: ${msg}`,
          action: "Pass --address <0x> explicitly, or fix the local wallet DB.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  if (rows.length === 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          code: "NO_ACTIVE_WALLET",
          message: "No active wallets in the local DB.",
          action: "Register a wallet first: `agent manage wallets register --provider hd`.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          code: "AMBIGUOUS_WALLET",
          message: `${rows.length} active wallets present — cannot default. Pass --address <0x> to choose one.`,
          addresses: rows.map((r) => r.address),
          action: "Run `agent manage wallets list` to see the addresses, then pick one with --address.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
  return rows[0].address;
}

/**
 * Loads the signing account for `walletAddress`, resolves the backend
 * URL, and invokes the given affiliate-side op (show/claim/upgrade).
 *
 * On account-load failure, returns a structured MyReferralCodeResult
 * shape (ok:false) so the caller's print path stays uniform.
 */
async function runReferralCodeOp(
  walletAddress: string,
  op: (ctx: {
    account: Awaited<ReturnType<typeof loadAccount>>;
    backendUrl: string;
  }) => Promise<MyReferralCodeResult>,
): Promise<MyReferralCodeResult> {
  const backendUrl =
    process.env.RT_AGENT_BACKEND_URL ||
    process.env.REZONTREE_API_URL ||
    "http://localhost:8080";

  let account: Awaited<ReturnType<typeof loadAccount>>;
  try {
    account = await loadAccount(walletAddress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "ACCOUNT_LOAD_FAILED",
      message: `Could not load signing account for ${walletAddress}: ${msg}`,
    };
  }

  return await op({ account, backendUrl });
}

/**
 * Print a referral-code op result to stdout and set the exit code.
 * Successful results print pretty JSON with code + url; failures
 * surface { ok:false, code, message, action } for operator parsing.
 */
function printReferralCodeResult(result: MyReferralCodeResult): void {
  if (result.ok) {
    log.info(
      {
        wallet: result.walletAddress,
        code: result.code,
        source: result.source,
        status: result.status,
      },
      "referral-code: ok",
    );
    // Audit-fix L3: omit `created_new` from JSON output when false.
    // On idempotent re-calls (the common case after first claim) it
    // adds no actionable information and confuses agent scripts that
    // would otherwise have to filter the field manually.
    //
    // Audit-fix P3 (round 3): when the backend didn't return a URL
    // (RT_PUBLIC_BASE_URL unset), surface a clear hint to the operator
    // explaining how to compute the canonical link instead of leaving
    // a missing field. Previously the CLI just omitted the URL and an
    // operator with only the code had no idea how to share it.
    const output: Record<string, unknown> = {
      ok: true,
      code: result.code,
      wallet_address: result.walletAddress,
      url: result.url,
      source: result.source,
      status: result.status,
      created_at: result.createdAt,
    };
    if (!result.url) {
      output.url_note =
        "Backend's RT_PUBLIC_BASE_URL is unset, so no canonical URL was returned. " +
        "Construct your own: https://<your-public-host>/r/" + result.code;
    }
    if (result.createdNew) {
      output.created_new = true;
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  log.warn(
    { backendCode: result.code, message: result.message },
    "referral-code: op failed",
  );
  console.error(
    JSON.stringify(
      {
        ok: false,
        code: result.code,
        message: result.message,
        action: result.action,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
