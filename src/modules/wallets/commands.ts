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
} from "./service.js";

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
      console.log(JSON.stringify({ ok: true, wallet: w }, null, 2));
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
