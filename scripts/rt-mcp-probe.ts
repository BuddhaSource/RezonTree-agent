// rt-mcp-probe.ts — cold-start agent's view of the hosted MCP.
// Does /mcp guide "how do I set up a wallet & fund it"? How discoverable is it?
const MCP = (process.env.RT_BACKEND_URL ?? "https://rezontree.com").replace(/\/$/, "") + "/mcp";

async function rpc(method: string, params: any, sid?: string): Promise<{ body: any; sid?: string }> {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sid ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }),
  });
  const newSid = res.headers.get("mcp-session-id") ?? sid;
  const text = await res.text();
  // Streamable-HTTP may frame the JSON in SSE "data:" lines.
  let body: any = null;
  if (text.includes("data:")) {
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    if (line) body = JSON.parse(line.slice(5).trim());
  } else {
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300), status: res.status }; }
  }
  return { body, sid: newSid };
}

const hit = (s: string) => /wallet|fund|deposit|usdc|balance|faucet|approve|allowance|private key|mnemonic|register|account/i.test(s);

async function main() {
  console.log(`MCP endpoint: ${MCP}\n`);

  // ── handshake ──
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "cold-start-probe", version: "1.0" } });
  const sid = init.sid;
  const instr: string = init.body?.result?.instructions ?? "";
  console.log("=== initialize.instructions (the cold-start spine an agent reads first) ===");
  console.log(instr ? instr : "  ⚠️  EMPTY — no top-level instructions");
  console.log(`  [length: ${instr.length} chars; mentions wallet/fund? ${hit(instr) ? "YES" : "NO"}]\n`);

  if (sid) await rpc("notifications/initialized", {}, sid);

  // ── tools ──
  const tools = await rpc("tools/list", {}, sid);
  const list: any[] = tools.body?.result?.tools ?? [];
  console.log(`=== tools/list (${list.length} tools) ===`);
  for (const t of list) {
    const d = (t.description ?? "").replace(/\s+/g, " ").trim();
    const flag = hit(t.name + " " + d) ? " 💰" : "";
    console.log(`  • ${t.name}${flag}\n      ${d ? d.slice(0, 160) : "⚠️ NO DESCRIPTION"}`);
  }

  // ── which tools speak to wallet-setup / funding? ──
  console.log(`\n=== WALLET-SETUP / FUNDING DISCOVERABILITY ===`);
  const walletTools = list.filter((t) => hit(t.name + " " + (t.description ?? "")));
  if (walletTools.length === 0) console.log("  ⚠️  NO tool name/description mentions wallet/fund/deposit — agent must guess");
  else for (const t of walletTools) console.log(`  ✓ ${t.name} — ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 200)}`);

  // ── prompts / resources (the other discovery channels) ──
  for (const ch of ["prompts/list", "resources/list"]) {
    const r = await rpc(ch, {}, sid);
    const arr = r.body?.result?.prompts ?? r.body?.result?.resources ?? [];
    console.log(`\n${ch}: ${Array.isArray(arr) ? arr.length : 0} ${r.body?.error ? "(error: " + (r.body.error.message ?? "?") + ")" : ""}`);
    for (const p of (Array.isArray(arr) ? arr : [])) console.log(`  • ${p.name ?? p.uri}: ${(p.description ?? "").slice(0, 120)}`);
  }
}
main().catch((e) => { console.error("PROBE ERROR:", e?.message ?? e); process.exit(1); });
