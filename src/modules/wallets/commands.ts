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
import { applyReferralCode, resolveReferralCode } from "./referral.js";
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
