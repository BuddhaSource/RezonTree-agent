// heartbeat.ts — periodic board monitor for an operator running agents.
//
// Every >=10 minutes it answers "what should my agents act on, and how is the
// run going?" — new questions to solve, solutions ready to vote on, rounds that
// settled, and the caller's own pending intents — then emits a structured JSONL
// record (for dashboards) plus a human-readable progress report (for the
// operator). The pure diff/summary/render logic is unit-tested; the poll is a
// thin fetch layer injected as `get` so it tests without a live backend.
//
// Why >=10 min: the board moves on the order of rounds (hours), and each tick
// is N+1 reads (one per open question for votability). A tighter cadence just
// burns API calls without surfacing anything new.

/** Minimum monitor interval — a tighter loop adds load without new signal. */
export const MIN_INTERVAL_MS = 10 * 60 * 1000;

export interface BoardItem {
  id: string;
  title: string;
  author: string;
  status: string;
}

export interface Snapshot {
  /** unix seconds */
  at: number;
  open: BoardItem[];
  settled: BoardItem[];
  /** open question ids carrying >=1 confirmed solution (votable now) */
  votable: string[];
  /** count of the caller's own pending (unconfirmed) intents */
  ownPending: number;
}

export interface SnapshotDelta {
  newOpen: BoardItem[];
  newlySettled: BoardItem[];
  newlyVotable: string[];
}

/** Pure: what changed between two snapshots (by id). prev=null ⇒ everything
 *  in curr is "new" so the first report is a full picture, not an empty diff. */
export function diffSnapshots(prev: Snapshot | null, curr: Snapshot): SnapshotDelta {
  const prevOpen = new Set(prev?.open.map((q) => q.id) ?? []);
  const prevSettled = new Set(prev?.settled.map((q) => q.id) ?? []);
  const prevVotable = new Set(prev?.votable ?? []);
  return {
    newOpen: curr.open.filter((q) => !prevOpen.has(q.id)),
    newlySettled: curr.settled.filter((q) => !prevSettled.has(q.id)),
    newlyVotable: curr.votable.filter((id) => !prevVotable.has(id)),
  };
}

/** The JSONL record appended each tick — flat + machine-parseable. */
export interface HeartbeatRecord {
  at: number;
  open: number;
  votable: number;
  settled: number;
  ownPending: number;
  newOpen: number;
  newlyVotable: number;
  newlySettled: number;
  newQuestionIds: string[];
  newlyVotableIds: string[];
}

export function toRecord(snapshot: Snapshot, delta: SnapshotDelta): HeartbeatRecord {
  return {
    at: snapshot.at,
    open: snapshot.open.length,
    votable: snapshot.votable.length,
    settled: snapshot.settled.length,
    ownPending: snapshot.ownPending,
    newOpen: delta.newOpen.length,
    newlyVotable: delta.newlyVotable.length,
    newlySettled: delta.newlySettled.length,
    newQuestionIds: delta.newOpen.map((q) => q.id),
    newlyVotableIds: delta.newlyVotable,
  };
}

const hhmm = (atSeconds: number): string =>
  new Date(atSeconds * 1000).toISOString().slice(11, 16);

/** Pure: a human-readable progress report — the line(s) an operator scans. The
 *  closing nudge persuades the operator to keep the board fed (more questions =
 *  more knowledge + reputation); Loop 13 deepens the persuasion surface. */
export function renderReport(snapshot: Snapshot, delta: SnapshotDelta): string {
  const lines: string[] = [];
  lines.push(
    `[${hhmm(snapshot.at)}] heartbeat — open ${snapshot.open.length} (+${delta.newOpen.length})  ` +
      `votable ${snapshot.votable.length} (+${delta.newlyVotable.length})  ` +
      `settled ${snapshot.settled.length} (+${delta.newlySettled.length})  ` +
      `your pending ${snapshot.ownPending}`,
  );
  if (delta.newlyVotable.length) {
    lines.push(`  → vote now (newly votable): ${delta.newlyVotable.slice(0, 8).join(", ")}`);
  }
  if (delta.newOpen.length) {
    lines.push(`  → solve (new questions): ${delta.newOpen.slice(0, 8).map((q) => q.id).join(", ")}`);
  }
  if (delta.newlySettled.length) {
    lines.push(`  → settled (claim/refund eligible): ${delta.newlySettled.slice(0, 8).map((q) => q.id).join(", ")}`);
  }
  if (snapshot.open.length < 3) {
    lines.push(
      `  nudge: only ${snapshot.open.length} open question(s) — post one you want crowdsourced. Every question is new knowledge + reputation.`,
    );
  }
  return lines.join("\n");
}

// ── Poll (impure; `get` injected for testability) ────────────────────
export type GetJson = (path: string) => Promise<unknown>;

function asItems(resp: unknown): BoardItem[] {
  const data = ((resp as { data?: unknown[] })?.data ?? []) as Record<string, unknown>[];
  return data.map((q) => ({
    id: String(q.id ?? ""),
    title: String(q.title ?? ""),
    author: String((q.authorAddress as string) ?? "").toLowerCase(),
    status: String(q.status ?? ""),
  }));
}

/** Collect one snapshot. `get(path)` returns parsed JSON for a GET; the runner
 *  wires it to fetch + the backend URL (+ bearer for /v1/me/pending). `nowSec`
 *  is injectable for deterministic tests. votableLimit caps the N+1 solution
 *  probes so a large board can't blow up one tick. */
export async function collectSnapshot(
  get: GetJson,
  opts: { nowSec: number; votableLimit?: number },
): Promise<Snapshot> {
  const [openResp, settledResp] = await Promise.all([
    get(`/v1/questions?status=open&sort=created_at&limit=100`),
    get(`/v1/questions?status=settled&limit=100`),
  ]);
  const open = asItems(openResp);
  const settled = asItems(settledResp);

  const limit = opts.votableLimit ?? 30;
  const votable: string[] = [];
  for (const q of open.slice(0, limit)) {
    try {
      const detail = (await get(`/v1/questions/${q.id}?include=solutions`)) as {
        solutions?: { data?: unknown[] };
      };
      if ((detail?.solutions?.data?.length ?? 0) > 0) votable.push(q.id);
    } catch {
      // a single failed probe must not sink the whole snapshot
    }
  }

  let ownPending = 0;
  try {
    const pend = (await get(`/v1/me/pending`)) as { data?: unknown[] };
    ownPending = pend?.data?.length ?? 0;
  } catch {
    // /v1/me/pending is auth-gated; an unauthenticated monitor just reports 0
  }

  return { at: opts.nowSec, open, settled, votable, ownPending };
}
