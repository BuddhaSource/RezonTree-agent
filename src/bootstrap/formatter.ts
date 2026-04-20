// Bootstrap output formatters — cartridge loop 0065.
//
// Pure string builders for the testnet-bootstrap script. Kept
// separate so they're unit-testable without actually hitting
// the RPC, backend, or filesystem.

import type { AgentWallet, BalanceSnapshot } from "../wallet/types.js";
import type { TestnetConfig } from "../testnet/config.js";

/** Produces the boxed address list the operator sees at phase A.
 *  One line per agent with the address, faucet hint, and an
 *  explorer URL. */
export function formatAddressList(
  wallets: AgentWallet[],
  cfg: TestnetConfig,
  agentNames: string[],
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `  Agents derived from RT_AGENT_MNEMONIC on ${cfg.name} (chain ${cfg.chainId}):`,
  );
  lines.push("");
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const name = agentNames[i] ?? `agent-${i}`;
    lines.push(`  [${i}] ${name.padEnd(18)} ${w.address}`);
    lines.push(
      `      explorer: ${cfg.explorerUrl}/address/${w.address}`,
    );
  }
  lines.push("");
  lines.push(`  Faucets:`);
  lines.push(`    ETH  ${cfg.faucetHints.nativeEth}`);
  lines.push(`    USDC ${cfg.faucetHints.usdc}`);
  lines.push(
    "",
  );
  lines.push(
    "  Fund each address above, then the script will auto-register.",
  );
  lines.push("");
  return lines.join("\n");
}

/** Produces the periodic "waiting for funding" status line. */
export function formatFundingStatus(
  wallets: AgentWallet[],
  snapshots: BalanceSnapshot[],
  fundedFlags: boolean[],
  agentNames: string[],
): string {
  const funded = fundedFlags.filter(Boolean).length;
  const total = wallets.length;
  const lines: string[] = [];
  lines.push(
    `  Funding progress: ${funded}/${total} agents at threshold`,
  );
  for (let i = 0; i < wallets.length; i++) {
    const name = agentNames[i] ?? `agent-${i}`;
    const snap = snapshots[i];
    const marker = fundedFlags[i] ? "✓" : " ";
    const eth = (Number(snap.nativeWei) / 1e18).toFixed(5);
    const usdc = (Number(snap.usdcMinor) / 1e6).toFixed(2);
    lines.push(
      `    ${marker} [${i}] ${name.padEnd(18)} ${eth} ETH | ${usdc} USDC`,
    );
  }
  return lines.join("\n");
}

/** Produces the final "all registered" summary block. */
export function formatRegistrationSummary(
  entries: Array<{
    index: number;
    name: string;
    address: string;
    agentId: string;
    httpStatus: number;
  }>,
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  Registration complete (${entries.length} agents):`);
  lines.push("");
  for (const e of entries) {
    lines.push(
      `    [${e.index}] ${e.name.padEnd(18)} ${e.address} → ${e.agentId} (${e.httpStatus})`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
