import { describe, expect, it } from "vitest";

import {
  collectSnapshot,
  diffSnapshots,
  renderReport,
  toRecord,
  type Snapshot,
} from "./heartbeat.js";

const item = (id: string, status = "open") => ({ id, title: `Q ${id}`, author: "0xabc", status });

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  at: 1_700_000_000,
  open: [],
  settled: [],
  votable: [],
  ownPending: 0,
  ...over,
});

describe("diffSnapshots", () => {
  it("treats everything as new when prev is null", () => {
    const curr = snap({ open: [item("a"), item("b")], settled: [item("s", "settled")], votable: ["a"] });
    const d = diffSnapshots(null, curr);
    expect(d.newOpen.map((q) => q.id)).toEqual(["a", "b"]);
    expect(d.newlySettled.map((q) => q.id)).toEqual(["s"]);
    expect(d.newlyVotable).toEqual(["a"]);
  });

  it("reports only the delta against a prior snapshot", () => {
    const prev = snap({ open: [item("a")], settled: [], votable: [] });
    const curr = snap({ open: [item("a"), item("b")], settled: [item("s", "settled")], votable: ["b"] });
    const d = diffSnapshots(prev, curr);
    expect(d.newOpen.map((q) => q.id)).toEqual(["b"]); // a is not new
    expect(d.newlySettled.map((q) => q.id)).toEqual(["s"]);
    expect(d.newlyVotable).toEqual(["b"]);
  });
});

describe("toRecord", () => {
  it("flattens snapshot + delta into a JSONL record", () => {
    const curr = snap({ open: [item("a"), item("b")], votable: ["a"], ownPending: 2 });
    const rec = toRecord(curr, diffSnapshots(null, curr));
    expect(rec).toMatchObject({ open: 2, votable: 1, ownPending: 2, newOpen: 2, newlyVotable: 1 });
    expect(rec.newQuestionIds).toEqual(["a", "b"]);
  });
});

describe("renderReport", () => {
  it("surfaces newly-votable + nudges when the board is thin", () => {
    const curr = snap({ open: [item("a")], votable: ["a"] });
    const out = renderReport(curr, diffSnapshots(null, curr));
    expect(out).toMatch(/heartbeat/);
    expect(out).toMatch(/vote now/);
    expect(out).toMatch(/nudge: only 1 open/i);
    expect(out).toMatch(/new knowledge \+ reputation/);
  });

  it("omits the nudge when the board is healthy", () => {
    const open = ["a", "b", "c", "d"].map((id) => item(id));
    const curr = snap({ open });
    const out = renderReport(curr, diffSnapshots(snap({ open }), curr));
    expect(out).not.toMatch(/nudge:/);
  });
});

describe("collectSnapshot", () => {
  it("polls open + settled + votability + own pending via injected get", async () => {
    const get = async (path: string): Promise<unknown> => {
      if (path.includes("status=open")) return { data: [{ id: "a", title: "A", status: "open" }, { id: "b", title: "B", status: "open" }] };
      if (path.includes("status=settled")) return { data: [{ id: "s", title: "S", status: "settled" }] };
      if (path.includes("/v1/questions/a")) return { solutions: { data: [{ intentHash: "0x1" }] } }; // a is votable
      if (path.includes("/v1/questions/b")) return { solutions: { data: [] } }; // b not votable
      if (path.includes("/v1/me/pending")) return { data: [{ id: "p1" }] };
      return {};
    };
    const s = await collectSnapshot(get, { nowSec: 123 });
    expect(s.at).toBe(123);
    expect(s.open.map((q) => q.id)).toEqual(["a", "b"]);
    expect(s.settled.map((q) => q.id)).toEqual(["s"]);
    expect(s.votable).toEqual(["a"]);
    expect(s.ownPending).toBe(1);
  });

  it("survives a failing /v1/me/pending (unauthenticated monitor → 0)", async () => {
    const get = async (path: string): Promise<unknown> => {
      if (path.includes("status=open")) return { data: [] };
      if (path.includes("status=settled")) return { data: [] };
      if (path.includes("/v1/me/pending")) throw new Error("401");
      return {};
    };
    const s = await collectSnapshot(get, { nowSec: 1 });
    expect(s.ownPending).toBe(0);
  });
});
