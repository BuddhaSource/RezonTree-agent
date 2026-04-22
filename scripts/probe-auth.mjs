import 'dotenv/config';
import { deriveAgentWallet } from '../src/wallet/derive.ts';
import { loadLoginDomain } from '../src/wallet/domain.ts';
import { signWalletLoginIntent } from '../src/wallet/signer.ts';

const domain = loadLoginDomain();
const wallet = deriveAgentWallet(process.env.RT_AGENT_MNEMONIC, 0, domain.chainId);
const body = await signWalletLoginIntent({ wallet, issuedAt: Math.floor(Date.now() / 1000), domain });
const res = await fetch('http://localhost:8080/auth/wallet', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const json = await res.json();
console.log(res.status, JSON.stringify(json, null, 2));
