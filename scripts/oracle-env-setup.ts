// oracle-env-setup.ts — derive idx 0's private key from RT_AGENT_MNEMONIC
// and write it into the BACKEND .env (not the agent .env) as
// ORACLE_QUORUM_KEYS, plus the related ORACLE_* vars.
//
// Never prints the key to stdout. Idempotent: if ORACLE_QUORUM_KEYS is
// already present in the target .env, the script aborts with a message.

import "dotenv/config";
import * as fs from "node:fs";
import { deriveAgentWallet } from "../src/wallet/derive.js";

const mnemonic = process.env.RT_AGENT_MNEMONIC;
if (!mnemonic) throw new Error("RT_AGENT_MNEMONIC not set");

const forge = process.env.RT_FORGE_ADDRESS;
if (!forge) throw new Error("RT_FORGE_ADDRESS not set");

const rpcUrl = process.env.RT_RPC_URL ?? "https://sepolia.base.org";
const chainID = "84532";

// Derive idx 0 (the configured oracle wallet, FORGE_DEFAULT_ORACLE).
// deriveAgentWallet uses BIP-44 path m/44'/60'/0'/0/<idx> — same as
// the rest of the agent-pool derivation, single source of truth.
const wallet = deriveAgentWallet(mnemonic, 0, Number(chainID));
const keyHex = wallet.privateKey.slice(2); // strip 0x for the env var

const backendEnv = "/Volumes/Data/projects/rezontree/RezonTree/.env";
if (!fs.existsSync(backendEnv)) {
  throw new Error(`backend .env not found at ${backendEnv}`);
}

const current = fs.readFileSync(backendEnv, "utf8");

// Idempotency guard.
if (current.includes("ORACLE_QUORUM_KEYS=") && !current.includes("ORACLE_QUORUM_KEYS=\n")) {
  console.error("ORACLE_QUORUM_KEYS already set in backend .env — skipping. Edit manually if you need to rotate.");
  process.exit(0);
}

const block = `

# === Oracle keeper (idx 0 EOA, dev-rpc mode) — added by oracle-env-setup.ts ===
ORACLE_ENABLED=true
ORACLE_CHAIN_ID=${chainID}
ORACLE_FORGE_ADDRESS=${forge}
ORACLE_PUBLISH_MODE=rpc
ORACLE_PUBLISH_RPC_URL=${rpcUrl}
ORACLE_QUORUM_KEYS=${keyHex}
ORACLE_QUORUM_THRESHOLD=1
ORACLE_POLL_INTERVAL=15s
ORACLE_FINALITY_BLOCKS=2
ALLOW_DEV_RPC=1
`;

fs.appendFileSync(backendEnv, block);
console.log(`✓ appended oracle env block to ${backendEnv} (key length=${keyHex.length}, address=derived from idx 0)`);
