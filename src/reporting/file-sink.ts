// File sink — cartridge loop 0064.
//
// Appends one JSONL per ErrorReport to `logs/errors-YYYY-MM-DD.jsonl`.
// Daily rotation keeps files bounded; ops can ship any day's
// file to an external indexer (Loki, Splunk, Datadog) without
// stateful consumption. JSON-per-line format parses trivially
// with jq / vector / promtail.
//
// No retention policy here — operators are expected to wire a
// cron/systemd-timer to prune old files (runbook entry at loop
// 65).

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ErrorReport, Sink } from "./types.js";

export interface FileSinkOptions {
  /** Directory where dated JSONL files live. Default `./logs`. */
  dir?: string;
  /** Clock override for tests. */
  now?: () => Date;
}

/** Builds a deterministic filename from a timestamp. YYYY-MM-DD
 *  in UTC to avoid cross-timezone rotation ambiguity (an agent
 *  crashing at midnight PST shouldn't split its death between
 *  two files from ops' perspective). */
export function filenameFor(date: Date, dir: string): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return join(dir, `errors-${y}-${m}-${d}.jsonl`);
}

export class FileSink implements Sink {
  readonly name = "file";
  private readonly dir: string;
  private readonly now: () => Date;
  private mkdirOnce: Promise<string | undefined> | null = null;

  constructor(opts: FileSinkOptions = {}) {
    this.dir = opts.dir ?? "./logs";
    this.now = opts.now ?? (() => new Date());
  }

  async write(report: ErrorReport): Promise<void> {
    // Ensure directory exists; memoize to avoid one mkdir per
    // write. `recursive: true` is a no-op if it already exists.
    if (!this.mkdirOnce) {
      this.mkdirOnce = mkdir(this.dir, { recursive: true });
    }
    await this.mkdirOnce;

    const path = filenameFor(this.now(), this.dir);
    // mkdir covers the parent dir of join(dir, file); defensive
    // in case `dir` was absolute and not yet created.
    const parent = dirname(path);
    if (parent !== this.dir) {
      await mkdir(parent, { recursive: true });
    }

    await appendFile(path, JSON.stringify(report) + "\n", "utf8");
  }
}
