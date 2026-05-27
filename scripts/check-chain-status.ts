import { createPublicClient, http, formatUnits } from 'viem';
import { baseSepolia } from 'viem/chains';

async function main() {
  const c = createPublicClient({ chain: baseSepolia, transport: http(process.env.FORGE_RPC_URL || 'https://sepolia.base.org') });
  const FORGE = process.env.RT_FORGE_ADDRESS as `0x${string}`;
  const ABI = [{
    name: 'getQuestionScalars', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'qid', type: 'bytes32' }],
    outputs: [
      { name: 'status', type: 'uint8' },
      { name: 'feeShareBps', type: 'uint16' },
      { name: 'voteFee', type: 'uint256' },
      { name: 'stakeBasisPoints', type: 'uint16' },
      { name: 'minStakeFloor', type: 'uint256' },
      { name: 'poolAmount', type: 'uint256' },
      { name: 'fundingDeadline', type: 'uint64' },
      { name: 'token', type: 'address' },
    ],
  }] as const;
  const qids: [string, `0x${string}`][] = [
    ['qst_d882mgq6xz1q96jbrfv0', '0x99e00953975b609cbb1d17b0468281513fee6c39da5001b260027c5865a76f57'],
    ['qst_d882n16t5n2apxjb77dg', '0x09273a398343a2c5d654b1621b83856eb3c4b8adb5e39d02a222c1a4b4227bde'],
    ['qst_d882nhr1anv0n05p1w40', '0xb041d293082d01afac6a60affc444638494fe7238d7c2fe5633b8388ec2e35c9'],
  ];
  const STATUSES = ['NotCreated','Draft','Open','Settling','Settled','Abandoned','Recovered'];
  for (const [qid_str, qid] of qids) {
    try {
      const r = await c.readContract({ address: FORGE, abi: ABI, functionName: 'getQuestionScalars', args: [qid] }) as readonly [number, number, bigint, number, bigint, bigint, bigint, `0x${string}`];
      console.log(`${qid_str}:`);
      console.log(`  status=${STATUSES[r[0]] ?? r[0]}`);
      console.log(`  pool=$${formatUnits(r[5], 6)} USDC`);
      console.log(`  fundingDeadline=${new Date(Number(r[6]) * 1000).toISOString()}`);
    } catch (e: any) {
      console.log(`${qid_str}: ERROR ${(e.message || e).toString().slice(0,200)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
