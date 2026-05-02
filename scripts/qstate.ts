import "dotenv/config";
import { createPublicClient, http } from "viem";
const c = createPublicClient({ transport: http("https://sepolia.base.org") });
const QSTATE = [{type:"function",name:"questions",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"uint8"},{type:"address"},{type:"address"},{type:"address"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"uint8"},{type:"uint256"},{type:"uint256"},{type:"uint256"},{type:"uint256"}]}] as const;
async function main() {
  const r = await c.readContract({ address: "0x6c70fb6f59e1f2c3b9456a30c3856be0032300d1", abi: QSTATE, functionName: "questions", args: ["0xc104e332b13d658d4dbe0134b86944c1ff992289dd7ee752a078bcab5289cb75"] }) as readonly [number,string,string,string,bigint,bigint,bigint,bigint,bigint,number,bigint,bigint,bigint,bigint];
  const now = Math.floor(Date.now()/1000);
  const fields = ["status (0=void,1=open,2=settled,3=abandoned)","sponsor","oracle","token","stakeFloor","stakeBasisPoints","sponsorshipFloor","voteFee","abandonmentGracePeriod","contributorCount","solutionCount","poolAmount","sponsoredAt","fundingDeadline"];
  fields.forEach((f,i)=>console.log(`  ${f}: ${r[i]}`));
  console.log("  now:", now);
  console.log("  fundingDeadline - now:", Number(r[13]) - now, "s");
}
main();
