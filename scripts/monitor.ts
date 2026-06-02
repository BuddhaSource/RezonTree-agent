#!/usr/bin/env tsx
// scripts/monitor.ts — the >=10-minute heartbeat runner.
//
// Polls the board on a cadence and tells the operator what their agents should
// act on next (new questions to solve, solutions to vote on, settled rounds)
// plus their own pending intents — appending a JSONL record (for dashboards)
// and printing a human progress report. Pure diff/render/summary logic lives in
// src/monitoring/heartbeat.ts (unit-tested); this is the thin loop + IO.
//
// Usage:  tsx scripts/monitor.ts            # loop forever, 10-min cadence
//         MONITOR_ONCE=1 tsx scripts/monitor.ts   # one tick then exit
// Env: RT_AGENT_BACKEND_URL, RT_AGENT_MNEMONIC (for /v1/me/pending; optional —
//      without it the monitor runs unauthenticated and reports pending=0),
//      MONITOR_INTERVAL_MS (default/min 600000), MONITOR_OUTPUT (default ./heartbeat.jsonl).
import "dotenv/config";
import { appendFileSync } from "node:fs";

import { loginWallet } from "../src/wallet/login.js";
import {
  collectSnapshot,
  diffSnapshots,
  renderReport,
  toRecord,
  MIN_INTERVAL_MS,
  type GetJson,
  type Snapshot,
} from "../src/monitoring/heartbeat.js";

const BACKEND = (process.env.RT_AGENT_BACKEND_URL ?? process.env.RT_BACKEND_URL ?? "http://localhost:8080").replace(/\/$/, "");
const MNEMONIC = process.env.RT_AGENT_MNEMONIC;
const OUTPUT = process.env.MONITOR_OUTPUT ?? "./heartbeat.jsonl";
const ONCE = process.env.MONITOR_ONCE === "1";
const INTERVAL_MS = Math.max(MIN_INTERVAL_MS, Number(process.env.MONITOR_INTERVAL_MS ?? MIN_INTERVAL_MS));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => Math.floor(Date.now() / 1000);

async function main(): Promise<void> {
  // Optional auth — only needed for /v1/me/pending. Public reads cover the rest.
  let bearer: string | undefined;
  if (MNEMONIC) {
    try { bearer = (await loginWallet(BACKEND, MNEMONIC, 0)).bearer; }
    catch (e) { console.error(`monitor: login failed (${(e as Error).message}); running unauthenticated`); }
  }

  const get: GetJson = async (path) => {
    const res = await fetch(`${BACKEND}${path}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
  };

  console.log(`monitor | backend ${BACKEND} | interval ${INTERVAL_MS / 1000}s | out ${OUTPUT} | auth ${bearer ? "yes" : "no"}`);

  let prev: Snapshot | null = null;
  for (;;) {
    try {
      const snapshot = await collectSnapshot(get, { nowSec: nowSec() });
      const delta = diffSnapshots(prev, snapshot);
      appendFileSync(OUTPUT, JSON.stringify(toRecord(snapshot, delta)) + "\n");
      console.log(renderReport(snapshot, delta));
      prev = snapshot;
    } catch (e) {
      console.error(`monitor tick error: ${(e as Error).message}`);
    }
    if (ONCE) break;
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
