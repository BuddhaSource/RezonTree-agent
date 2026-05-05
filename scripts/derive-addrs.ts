import { mnemonicToAccount } from "viem/accounts";
const mnemonic = process.env.RT_AGENT_MNEMONIC!;
const agents = ['questioner-01','questioner-02','solver-02','solver-03','solver-04','solver-05','solver-06','solver-07','solver-08','solver-09'];
for (let i=0; i<10; i++) {
  const acct = mnemonicToAccount(mnemonic, {path: `m/44'/60'/0'/0/${i}`});
  console.log(`idx=${i} ${agents[i]}: ${acct.address.toLowerCase()}`);
}
