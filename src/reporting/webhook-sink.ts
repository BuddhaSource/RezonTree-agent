// Webhook sink — cartridge loop 0064.
//
// POSTs batches of ErrorReports to a configured URL (Slack,
// Discord, custom handler). Batched with a 5-second debounce
// to avoid flooding the endpoint under a thundering-herd
// failure. Slack + Discord both accept simple `{text: "..."}`
// bodies; custom endpoints can parse the full `reports[]`
// array passed alongside.
//
// Failure policy: a failed POST is LOGGED to stderr (via the
// Reporter's own stderr sink if configured) and dropped. We
// don't retry; the file sink serves as the canonical record,
// and persistent retry queues are out of scope for staging.

import type { ErrorReport, Sink } from "./types.js";

export interface WebhookSinkOptions {
  url: string;
  /** Debounce window — any new report pushes the flush this
   *  many ms into the future. Default 5000. */
  debounceMs?: number;
  /** Clock override for tests. */
  now?: () => number;
  /** fetch override for tests. */
  fetchImpl?: typeof fetch;
}

export class WebhookSink implements Sink {
  readonly name = "webhook";
  private readonly url: string;
  private readonly debounceMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private queue: ErrorReport[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(opts: WebhookSinkOptions) {
    this.url = opts.url;
    this.debounceMs = opts.debounceMs ?? 5000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
  }

  async write(report: ErrorReport): Promise<void> {
    if (this.closed) return;
    this.queue.push(report);
    this.scheduleFlush();
  }

  /** Flushes immediately; used on close(). Public so tests can
   *  trigger without waiting on the debounce timer. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];

    // Slack + Discord + most webhook receivers accept a `text`
    // field with the one-line summary + a `reports` field with
    // the full JSON batch (custom handlers parse reports). This
    // shape works with a vanilla Slack incoming webhook.
    const summary = batch
      .map((r) => {
        const who = r.agentName ? `[${r.agentName}] ` : "";
        return `${who}${r.errorClass} ${r.code}: ${r.message}`;
      })
      .join("\n");

    const body = {
      text: summary.slice(0, 3900), // Slack message-length cap
      reports: batch,
    };

    try {
      await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Drop after one failed POST. File sink still has the
      // record. Writing to stderr would recurse into the
      // reporter, so go direct.
      process.stderr.write(
        `[reporter.webhook] POST to ${this.url} failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.debounceMs);
  }
}
