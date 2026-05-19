// recover-swarm-refunds.ts — pulls all stuck refunds from the 2026-05-13
// 25-question swarm. Calls RezonForge.{sponsorRefund, commitRefund,
// voteRefund} from each role's wallet. Idempotent: contract reverts on
// double-refund (already-refunded marker), the script tolerates that.
//
// Run with: RT_AGENT_MNEMONIC=... RT_FORGE_ADDRESS=0x... pnpm tsx scripts/recover-swarm-refunds.ts

import { mnemonicToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http, formatUnits } from "viem";
import { baseSepolia } from "viem/chains";

const MNEMONIC = process.env.RT_AGENT_MNEMONIC!;
const FORGE = process.env.RT_FORGE_ADDRESS as `0x${string}`;
const RPC = process.env.FORGE_RPC_URL || process.env.RT_RPC_URL || "https://sepolia.base.org";

if (!MNEMONIC || !FORGE) {
  console.error("Missing RT_AGENT_MNEMONIC or RT_FORGE_ADDRESS");
  process.exit(1);
}

const FORGE_ABI = [
  { type: "function", name: "sponsorRefund", inputs: [{ name: "questionId", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "commitRefund",  inputs: [{ name: "questionId", type: "bytes32" }, { name: "intentHash", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "voteRefund",    inputs: [{ name: "questionId", type: "bytes32" }, { name: "intentHash", type: "bytes32" }], outputs: [], stateMutability: "nonpayable" },
] as const;

// HD address derivation, indexes 1-15
function deriveAddress(idx: number): `0x${string}` {
  return mnemonicToAccount(MNEMONIC, { addressIndex: idx }).address;
}

// Build address → idx map for swarm wallets.
const addrToIdx = new Map<string, number>();
for (let i = 1; i <= 15; i++) {
  addrToIdx.set(deriveAddress(i).toLowerCase(), i);
}

// Per-role pending refund lists (from DB queries — see /Volumes/Data/projects/rezontree/RezonTree-agent/scripts/recover-swarm-refunds.ts inputs)
const SPONSOR_REFUNDS: { funder: string; qid: `0x${string}` }[] = [
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0x751b944f2fc1eb6175484533d564962fd1086ddf10d0fdd8d11b01a7ecc7576e" },
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0xe148b0d8291c62297a4f05559a11536415cc4c9b627dd6224b4b4a6fe1a996ae" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xc30be509d1055769e0efb525b39247f2cf5cdd3c961a3f8466fd108d7e74ef1c" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0x6e31cc3e7531583ac61ed80e2651d2bd28237015a8096d6fa7a93226e5510c73" },
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0x819f81330e02e16f70207c759f3febaa965ea6619083907ae13851655218d266" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xb9a9c15433c4ce0b7bf0b82b18fe3fb071720a3487b22a1b4394e7112a298a05" },
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0x3c32c149a6e1c3f4dc3adc56563ef0a5084e04ee8e285ad25addb0d21b5c8734" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xa76e078c4e580a86c61403d39807c42401c11870dce087a7543e8ea4ad83c99c" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0x9212f2193b2807e64b6e3db4338ffc8608f413ab8a9cf51acb3428e5aef92af2" },
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0x9f5bfab3c71a9598805012cd4c43e3053ccf245c790ae2c12c8482b74b03fd73" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xbb7961139776b3a76fa086243f53a5757f6959002530b3f14652e8cb6ac60438" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xe4c8c35eef571c25a4a7426340c45dcf4bd667500445dc596fbead567b18473a" },
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0xf0f3c82f85613e8f9feac41541c147376c01a0e21af1db93be703031aee968bd" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xcfa9194abd5a0507ec4d41b9b0eda4a32bd82e6f6e1da5e5a97613286b726164" },
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0xa6d36cb2515627651d8657b5fa0a99a3b1c9bdc92db3725780bea1f21504bb94" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0x37cde8c723ddc2cf7d2de745f8482549bd5027fe8ad1ef96757eb0ce10f98316" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0x488c8cd3a8308d4ee08cf473c00563813c4eb2e4a9a87048b8f5460ea59c0ea7" },
  { funder: "0x8a589e3210db52658505e1681dcd36fa973ba7c3", qid: "0xf75160abef0ec11036ecf1acbbf1acc2d064c4b92f82ae319404c9e3b8333720" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xed6a85e7e579cffc7097ec4b115d2a3ebf7524b16fee510bea304e17e21aa3de" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xb9db4d2b2c4e9cfec03f48b51d67072c7143c8ce7d05523c0f5e17b35bd219f9" },
  { funder: "0x483c51061e6106fe4e08e138428336a519fc0533", qid: "0xc52503282befc8a48be3b2bf29f2f7d82c88d90e2a0d1248e925b7d6f3282a83" },
];

const COMMIT_REFUNDS: { solver: string; qid: `0x${string}`; intentHash: `0x${string}` }[] = [
  { solver: "0xf0c36cac44ca127aae7e31c1913afba677e24501", qid: "0x819f81330e02e16f70207c759f3febaa965ea6619083907ae13851655218d266", intentHash: "0x2d67ce55801936ac99e0198d291293897eb5edf4453a316225c2e4c7de7295c6" },
  { solver: "0x7498bec7b27896c4fa7df254c5ec8a11dd004601", qid: "0x819f81330e02e16f70207c759f3febaa965ea6619083907ae13851655218d266", intentHash: "0x491891708850179d4701d3d5339a259ca965fa30d371fab3650ad0de0f98eeb3" },
  { solver: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0x819f81330e02e16f70207c759f3febaa965ea6619083907ae13851655218d266", intentHash: "0xf8243a3b8a72427b0196c90de2d845a793ef64e582678adfc6ca0c35dec382f8" },
  { solver: "0x4c539165a91878e4be9d90809bf70c6dc31120a3", qid: "0x3c32c149a6e1c3f4dc3adc56563ef0a5084e04ee8e285ad25addb0d21b5c8734", intentHash: "0x5941cd57faa848588ae41b014725ff616daad8c8b8a243e0dd5bf346b924eedb" },
  { solver: "0x7498bec7b27896c4fa7df254c5ec8a11dd004601", qid: "0xe148b0d8291c62297a4f05559a11536415cc4c9b627dd6224b4b4a6fe1a996ae", intentHash: "0xde56369cf56aa850cf2e898b9bd26951e054f3a80d137f4f8d7e32bc524966b0" },
  { solver: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0xe148b0d8291c62297a4f05559a11536415cc4c9b627dd6224b4b4a6fe1a996ae", intentHash: "0x22823da1d4408a8f9aacbe5916a362277b5e3bbe15a8ecd2f11cd80e70d3f06d" },
  { solver: "0x4c539165a91878e4be9d90809bf70c6dc31120a3", qid: "0x819f81330e02e16f70207c759f3febaa965ea6619083907ae13851655218d266", intentHash: "0xf72db287e964438f3045334b4c138302e207f8eae4eeb5bb684f8853c5031f3d" },
  { solver: "0xf0c36cac44ca127aae7e31c1913afba677e24501", qid: "0xe148b0d8291c62297a4f05559a11536415cc4c9b627dd6224b4b4a6fe1a996ae", intentHash: "0xc8d5a728723f81d2156b3868910d3e0d048266865e975263f4649023ca947e12" },
  { solver: "0x7498bec7b27896c4fa7df254c5ec8a11dd004601", qid: "0x751b944f2fc1eb6175484533d564962fd1086ddf10d0fdd8d11b01a7ecc7576e", intentHash: "0x38b2770cd6bf469d23ff1cc93e663c6b477828992a009fc4f19e9fa5bdd14ba3" },
  { solver: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0x9212f2193b2807e64b6e3db4338ffc8608f413ab8a9cf51acb3428e5aef92af2", intentHash: "0xc7e9bf28632a12becb325dfde32583cba3deecc854f7c9c0cd1acf6aec292a5b" },
  { solver: "0x4c539165a91878e4be9d90809bf70c6dc31120a3", qid: "0x9212f2193b2807e64b6e3db4338ffc8608f413ab8a9cf51acb3428e5aef92af2", intentHash: "0x5da3b7b90f305b351fd4abf83520f6f37122d8fe00e475244ca156c9a295786d" },
];

const VOTE_REFUNDS: { voter: string; qid: `0x${string}`; intentHash: `0x${string}` }[] = [
  { voter: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0x819f81330e02e16f70207c759f3febaa965ea6619083907ae13851655218d266", intentHash: "0xd12b61d6d19904fcfe200f0404dbf6e370b01ce8563b406e2007129a4357e184" },
  { voter: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0xe148b0d8291c62297a4f05559a11536415cc4c9b627dd6224b4b4a6fe1a996ae", intentHash: "0xb04de816b8f37eff949bf1a94850aa94ab4327be921c338e1ab246d81817215a" },
  { voter: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0x3c32c149a6e1c3f4dc3adc56563ef0a5084e04ee8e285ad25addb0d21b5c8734", intentHash: "0x02102fbebfa72db61f31af4ae5d8177fe01613fce95c0efbcad3173881efc913" },
  { voter: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0x751b944f2fc1eb6175484533d564962fd1086ddf10d0fdd8d11b01a7ecc7576e", intentHash: "0xcc782eb9ebe48b503e3fabe7605ed2d194bec1885779f5d6625e72abb034eb55" },
  { voter: "0xe7447873fff48d6d737545e1573774a48f1655ff", qid: "0x9212f2193b2807e64b6e3db4338ffc8608f413ab8a9cf51acb3428e5aef92af2", intentHash: "0x62a2153aaa45ace64cffe7c01127db02005fd17e64234cb7b19ee40ba580cc6a" },
];

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

async function callRefund(
  addr: string,
  fnName: "sponsorRefund" | "commitRefund" | "voteRefund",
  args: readonly `0x${string}`[],
): Promise<string> {
  const idx = addrToIdx.get(addr.toLowerCase());
  if (idx === undefined) {
    return `SKIP — no HD index match for ${addr}`;
  }
  const account = mnemonicToAccount(MNEMONIC, { addressIndex: idx });
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
  try {
    const hash = await wallet.writeContract({ address: FORGE, abi: FORGE_ABI, functionName: fnName, args: args as any });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success" ? `OK ${hash}` : `REVERT ${hash}`;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ContractFunctionExecutionError "AlreadyRefunded" / "AlreadyClaimed" = idempotent.
    if (/AlreadyRefunded|AlreadyClaimed|ExecutionReverted/.test(msg)) {
      return `SKIP — already refunded`;
    }
    return `ERR ${msg.slice(0, 120)}`;
  }
}

async function main() {
  console.log(`Recovering ${SPONSOR_REFUNDS.length} sponsor + ${COMMIT_REFUNDS.length} commit + ${VOTE_REFUNDS.length} vote refunds`);
  console.log(`Forge: ${FORGE}`);
  console.log("");

  const totals = { sponsor: 0, commit: 0, vote: 0, skip: 0, err: 0 };

  console.log("=== Sponsor refunds ===");
  for (const r of SPONSOR_REFUNDS) {
    const result = await callRefund(r.funder, "sponsorRefund", [r.qid]);
    const status = result.startsWith("OK") ? "✓" : result.startsWith("SKIP") ? "○" : "✗";
    console.log(`  ${status} ${r.funder.slice(0, 10)}... qid ${r.qid.slice(0, 10)}... — ${result}`);
    if (result.startsWith("OK")) totals.sponsor++;
    else if (result.startsWith("SKIP")) totals.skip++;
    else totals.err++;
  }

  console.log("\n=== Commit refunds ===");
  for (const r of COMMIT_REFUNDS) {
    const result = await callRefund(r.solver, "commitRefund", [r.qid, r.intentHash]);
    const status = result.startsWith("OK") ? "✓" : result.startsWith("SKIP") ? "○" : "✗";
    console.log(`  ${status} ${r.solver.slice(0, 10)}... ih ${r.intentHash.slice(0, 10)}... — ${result}`);
    if (result.startsWith("OK")) totals.commit++;
    else if (result.startsWith("SKIP")) totals.skip++;
    else totals.err++;
  }

  console.log("\n=== Vote refunds ===");
  for (const r of VOTE_REFUNDS) {
    const result = await callRefund(r.voter, "voteRefund", [r.qid, r.intentHash]);
    const status = result.startsWith("OK") ? "✓" : result.startsWith("SKIP") ? "○" : "✗";
    console.log(`  ${status} ${r.voter.slice(0, 10)}... ih ${r.intentHash.slice(0, 10)}... — ${result}`);
    if (result.startsWith("OK")) totals.vote++;
    else if (result.startsWith("SKIP")) totals.skip++;
    else totals.err++;
  }

  console.log("\n=== Summary ===");
  console.log(`  Sponsor refunds: ${totals.sponsor} OK`);
  console.log(`  Commit refunds:  ${totals.commit} OK`);
  console.log(`  Vote refunds:    ${totals.vote} OK`);
  console.log(`  Skipped:         ${totals.skip}`);
  console.log(`  Errors:          ${totals.err}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
