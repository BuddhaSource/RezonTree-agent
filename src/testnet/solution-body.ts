// solution-body.ts — synthetic solution-body generator for the Phase
// D battle harness.
//
// Backend's MinSolutionBodyChars is 2000. SA-009
// hardening: we pad to >=2200 chars with a deterministic footer
// keyed by scenarioId so identical inputs yield identical bodies
// (intent integrity preserved — same content_hash). Hard floor
// asserts so we fail fast instead of letting the backend reject
// with a 400.
//
// Content is genuine markdown — headings, fenced code, inline
// code for SQL identifiers, bold emphasis. The UI's Markdown
// component (react-markdown + remark-gfm + rehype-sanitize)
// renders it with structure; without markdown syntax it would
// render as a flat wall of prose.

import { keccak256, toBytes } from "viem";

/** Floor with margin over backend's 2000-char minimum. */
export const MIN_SOLUTION_BODY_CHARS = 2200;

/**
 * Deterministic evidence footer keyed by scenarioId. Same id ⇒ same
 * footer ⇒ same content_hash on retry.
 */
export function deterministicEvidenceFooter(scenarioId: string): string {
  const seed = keccak256(
    toBytes(`rezontree:solution-footer:v1:${scenarioId}`),
  );
  const phrases = [
    "Reasoning audit follows the canonical postgresql-hackers thread on online schema change",
    "with cross-reference to GitHub gh-ost's column-migration playbook and Stripe's CHECK NOT VALID",
    "post-migration validation runbook. Each citation describes why ADD CONSTRAINT NOT VALID then",
    "VALIDATE CONSTRAINT separately is preferred over a single ALTER TABLE on a 50M-row table.",
  ];
  const startByte = parseInt(seed.slice(2, 4), 16);
  const start = startByte % phrases.length;
  const rotated = [...phrases.slice(start), ...phrases.slice(0, start)];
  return rotated.join(" ");
}

/**
 * Build a deterministic synthetic solution body for `solver` /
 * `scenarioId`. Always >= MIN_SOLUTION_BODY_CHARS — the assertion at
 * the bottom is the production tripwire.
 */
export function makeSolutionBody(solver: string, scenarioId: string): string {
  let body = [
    `Solution by **${solver}** for scenario \`${scenarioId}\`.`,
    "",
    "## Approach",
    "",
    "Dual-write the new column behind an application flag while shadow-filling rows in chunks of 10k via a background job. Reads tolerate `NULL` during the fill window; writes go to both columns. Once shadow-fill completes the constraint is added with `NOT VALID` and validated separately so the validation scan does not block writers (Postgres > 12 pattern, see `ALTER TABLE ... VALIDATE CONSTRAINT` semantics).",
    "",
    "```sql",
    "ALTER TABLE accounts",
    "  ADD CONSTRAINT accounts_email_not_null",
    "  CHECK (email IS NOT NULL) NOT VALID;",
    "",
    "ALTER TABLE accounts",
    "  VALIDATE CONSTRAINT accounts_email_not_null;",
    "```",
    "",
    "## Evidence",
    "",
    "This is the canonical **Strangler** approach — Stripe's `CHECK`-then-`VALIDATE` post on Skycfg, GitHub's gh-ost playbooks, and pgsql-hackers archives all converge on shadow-fill + validate-without-lock. Skipping `NOT VALID` forces a full table scan under `AccessExclusiveLock`; the wedge here is hours of write downtime on a 50M-row table.",
    "",
    "## Edge cases",
    "",
    "- Backfill must respect `FOR UPDATE SKIP LOCKED` so concurrent app writes do not deadlock with the chunker.",
    "- An idempotent `UPSERT` pattern lets the chunker re-run without producing duplicates if interrupted.",
    "- Readers must treat `NULL` as *not yet migrated* and not silently coerce.",
    "- Replication slot headroom must be monitored — long backfill batches inflate WAL retention and can fill the slot's reserved disk.",
    "",
    "## Why-not alternatives",
    "",
    "- `pg_repack` rewrites the whole table (acceptable but slow and leaves replicas behind).",
    "- `ALTER TABLE ... SET DEFAULT` in PG11+ rewrites the column metadata only — but that does not satisfy `NOT NULL` when historical rows are present.",
  ].join("\n");
  if (body.length < MIN_SOLUTION_BODY_CHARS) {
    const footer = deterministicEvidenceFooter(scenarioId);
    body = `${body}\n\n${footer}`;
    while (body.length < MIN_SOLUTION_BODY_CHARS) {
      body = `${body} ${footer}`;
    }
  }
  if (body.length < MIN_SOLUTION_BODY_CHARS) {
    throw new Error(
      `makeSolutionBody: body length ${body.length} < floor ${MIN_SOLUTION_BODY_CHARS}`,
    );
  }
  return body;
}
