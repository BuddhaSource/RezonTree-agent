// Stderr sink — cartridge loop 0064.
//
// Writes a single human-readable line per ErrorReport to
// process.stderr. Default-on in dev; disable via Reporter
// options in production if the stdout/stderr pipeline is
// already structured (e.g. running under systemd or docker
// with promtail).
//
// Intentionally minimal — no color codes, no truncation, no
// JSON. The file sink is authoritative; this is for terminal
// operators tailing the process.

import type { ErrorReport, Sink } from "./types.js";

export class StderrSink implements Sink {
  readonly name = "stderr";
  private readonly write_: (s: string) => void;

  constructor(opts: { write?: (s: string) => void } = {}) {
    this.write_ = opts.write ?? ((s) => process.stderr.write(s));
  }

  async write(report: ErrorReport): Promise<void> {
    const who = report.agentName ? `[${report.agentName}] ` : "";
    const action = report.action ? ` action=${report.action}` : "";
    const reqID = report.request_id ? ` req=${report.request_id}` : "";
    this.write_(
      `[${report.timestamp}] ${who}${report.errorClass} ${report.code}: ${report.message}${action}${reqID}\n`,
    );
  }
}
