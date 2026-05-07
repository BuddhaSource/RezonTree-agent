// Reporter.
//
// Central error-reporting funnel. Agents + runtime call
// `reporter.report(err, context)`; the reporter classifies the
// error, builds an ErrorReport, and fans out to enabled sinks.
//
// Routing policy (per ErrorClass):
//   - info:     stderr only (noise floor)
//   - agent:    file + stderr
//   - protocol: file + stderr + webhook
//   - wallet:   file + stderr + webhook
//   - fatal:    file + stderr + webhook + process.exit(1) AFTER
//               flushing (caller can opt out via options for
//               controlled shutdown paths)
//
// Sinks are composable — pass whatever Sink[] makes sense for
// the deploy context. `fromEnv()` builds the canonical setup
// from RT_AGENT_ERROR_* env vars.

import type { ErrorClass, ErrorReport, Sink } from "./types.js";
import { classifyError } from "./classify.js";
import { FileSink } from "./file-sink.js";
import { StderrSink } from "./stderr-sink.js";
import { WebhookSink } from "./webhook-sink.js";

export interface ReporterOptions {
  sinks: Sink[];
  /** Override fatal-class exit behavior for tests. Default
   *  calls process.exit(1); tests pass a no-op. */
  onFatal?: () => void;
}

export interface ReportContext {
  agentName?: string;
  agentIndex?: number;
  /** Arbitrary extras — questionId, toolName, requestId, etc. */
  [k: string]: unknown;
}

export class Reporter {
  private readonly sinks: Sink[];
  private readonly onFatal: () => void;

  constructor(opts: ReporterOptions) {
    this.sinks = opts.sinks;
    this.onFatal = opts.onFatal ?? (() => process.exit(1));
  }

  /** Classify + fan-out. Returns the ErrorReport for the
   *  caller's downstream use (logging summary line, test
   *  asserts). */
  async report(err: unknown, context: ReportContext = {}): Promise<ErrorReport> {
    const cls = classifyError(err);
    const now = new Date();
    const { agentName, agentIndex, ...rest } = context;
    const report: ErrorReport = {
      timestamp: now.toISOString(),
      unix_seconds: Math.floor(now.getTime() / 1000),
      errorClass: cls.errorClass,
      agentName,
      agentIndex,
      code: cls.code,
      message: cls.message,
      action: cls.action,
      request_id: cls.request_id,
      stack: cls.stack,
      context: Object.keys(rest).length > 0 ? rest : undefined,
    };

    const active = sinksForClass(this.sinks, cls.errorClass);
    await Promise.allSettled(active.map((s) => s.write(report)));

    if (cls.errorClass === "fatal") {
      // Ensure sinks flush before the process dies. close()
      // is idempotent; webhook's debounced queue drains.
      await Promise.allSettled(
        this.sinks.map((s) => (s.close ? s.close() : Promise.resolve())),
      );
      this.onFatal();
    }

    return report;
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.sinks.map((s) => (s.close ? s.close() : Promise.resolve())),
    );
  }
}

/** Selects which sinks apply per class. info-only errors don't
 *  spam file/webhook; fatal errors go everywhere. */
function sinksForClass(all: Sink[], cls: ErrorClass): Sink[] {
  if (cls === "info") {
    return all.filter((s) => s.name === "stderr");
  }
  if (cls === "agent") {
    return all.filter((s) => s.name === "file" || s.name === "stderr");
  }
  // protocol / wallet / fatal → all sinks.
  return all;
}

/**
 * Builds the canonical production-shaped reporter from env:
 *
 *   RT_AGENT_ERROR_FILE_DIR         default "./logs"
 *   RT_AGENT_ERROR_WEBHOOK_URL      opt-in; enables WebhookSink
 *   RT_AGENT_ERROR_STDERR_ENABLED   "false" disables; default on
 *
 * Stderr is on by default; file is always on; webhook is opt-in.
 */
export function fromEnv(): Reporter {
  const sinks: Sink[] = [];
  sinks.push(
    new FileSink({ dir: process.env.RT_AGENT_ERROR_FILE_DIR ?? "./logs" }),
  );
  if (process.env.RT_AGENT_ERROR_STDERR_ENABLED !== "false") {
    sinks.push(new StderrSink());
  }
  const webhookUrl = process.env.RT_AGENT_ERROR_WEBHOOK_URL?.trim();
  if (webhookUrl) {
    sinks.push(new WebhookSink({ url: webhookUrl }));
  }
  return new Reporter({ sinks });
}
