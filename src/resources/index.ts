// resources/ — the agent working directory (a.k.a. the research workspace).
//
// A Django-style merged file tree an agent reads as ONE view, across three
// SCOPES (most-specific wins):
//
//   <RT_RESOURCE_DIR>/                        (default ./rezontree-files)
//     common/<category>/...                   shared by every agent (cross-project)
//     personas/<personaId>/<category>/...     this persona only
//     questions/<qid>/<category>/...          this question only (very specific)
//
// On read we walk the relevant scopes and merge: question shadows persona
// shadows common (the same "local wins" rule as the {name}.local.md card
// overlay in skills/load.ts). So an agent always sees the shared files PLUS
// its own PLUS the ones for the question it's researching, and chooses scope
// by WHERE it writes: drop a file in common/ and every agent gets it; drop it
// under a persona and only that persona does; drop it under a question and it
// stays scoped to that investigation.
//
// Categories are the SAME three folders in every scope — `tools/` for
// downloadable tools/code (e.g. a Polymarket helper an agent runs instead of
// building one), `research/` for gathered material (downloads, PDFs, cloned
// repos, sources, notes), `working/` for scratch. Entries can be files OR
// directories (a cloned GitHub repo is a dir).
//
// DETERMINISM NOTE (anti-drift): the RESEARCH is non-deterministic (what an
// agent downloads/reads/synthesises is judgement). But WHERE it lands and HOW
// it is named is DETERMINISTIC — every agent uses these helpers + the canonical
// RESEARCH_SUBDIRS, so open-ended work always produces a predictable,
// drift-free folder layout. Never hand-roll a path; always go through here (or
// `rt research`). See src/skills/research-framework.md.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Shipped default categories — the SAME structure in every scope. Extensible:
 *  any folder under a scope is picked up; these are the ones the SDK scaffolds
 *  and documents. */
export const RESOURCE_CATEGORIES = ["tools", "research", "working"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

/** Canonical sub-layout INSIDE `research/`. Same names in every scope so a
 *  PDF, a clone, or a saved source always has one obvious home — the
 *  deterministic skeleton that keeps non-deterministic research drift-free. */
export const RESEARCH_SUBDIRS = [
  "downloads", // raw fetches: zips, datasets, exports
  "pdfs", // papers, specs, reports
  "repos", // cloned codebases / projects
  "sources", // saved web pages / snapshots (html/md)
  "notes", // the agent's own synthesis + citations
] as const;
export type ResearchSubdir = (typeof RESEARCH_SUBDIRS)[number];

/** The three scopes, narrowest-last (most specific wins on a name clash). */
export type ResourceScope = "common" | "persona" | "question";

export interface ResourceEntry {
  /** Base name (file or directory). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Which scope it came from. */
  scope: ResourceScope;
  category: ResourceCategory;
  /** "file" — readable content; "dir" — e.g. a cloned repo or tool package. */
  kind: "file" | "dir";
}

/** Root of the working directory. Operator-set via RT_RESOURCE_DIR; defaults
 *  to ./rezontree-files relative to the process cwd so it's visible. */
export function resourceRoot(): string {
  return resolve(process.env.RT_RESOURCE_DIR ?? "rezontree-files");
}

/** Lowercase, separator-free slug so a personaId / qid can never escape its
 *  folder (path-traversal guard). */
function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return out || "agent";
}

/** Reject names that try to climb out of their category dir. */
function safeName(name: string): string {
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new Error(`unsafe resource name: ${name}`);
  }
  return name;
}

/** Resolve the on-disk category dir for a scope. `key` is the personaId
 *  (persona scope) or the qid (question scope); ignored for common. */
function categoryDir(
  scope: ResourceScope,
  key: string,
  category: ResourceCategory,
): string {
  const root = resourceRoot();
  switch (scope) {
    case "common":
      return join(root, "common", category);
    case "persona":
      return join(root, "personas", slugify(key), category);
    case "question":
      return join(root, "questions", slugify(key), category);
  }
}

/** The scope tiers walked on a merged read, broadest-first so a narrower scope
 *  shadows it. A question id, when given, adds the most-specific tier. */
function readTiers(
  personaId: string,
  qid?: string,
): Array<[ResourceScope, string]> {
  const tiers: Array<[ResourceScope, string]> = [
    ["common", ""],
    ["persona", personaId],
  ];
  if (qid) tiers.push(["question", qid]);
  return tiers;
}

/** List entries for (persona, category) as ONE merged view of common +
 *  persona — and, when `qid` is given, the question scope too. A narrower
 *  scope shadows a broader one of the same name. Returns files and directories
 *  sorted by name; missing dirs are skipped. */
export function listResources(
  personaId: string,
  category: ResourceCategory,
  qid?: string,
): ResourceEntry[] {
  const byName = new Map<string, ResourceEntry>();
  // Broadest first → narrower scopes overwrite on a name clash.
  for (const [scope, key] of readTiers(personaId, qid)) {
    const dir = categoryDir(scope, key, category);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      byName.set(name, {
        name,
        path,
        scope,
        category,
        kind: st.isDirectory() ? "dir" : "file",
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a named file, narrowest scope first (question → persona → common; the
 *  question tier is only consulted when `qid` is given). Returns null if absent
 *  in every scope. */
export function readResource(
  personaId: string,
  category: ResourceCategory,
  name: string,
  qid?: string,
): string | null {
  safeName(name);
  // Reverse readTiers: narrowest first so a specific file wins.
  const tiers = readTiers(personaId, qid).reverse();
  for (const [scope, key] of tiers) {
    const path = join(categoryDir(scope, key, category), name);
    if (existsSync(path) && statSync(path).isFile()) {
      return readFileSync(path, "utf8");
    }
  }
  return null;
}

/** Resolve (creating it) the directory to WRITE into — download a tool, clone
 *  a repo, save research — at the chosen scope. `key` is the personaId for
 *  `persona` scope, the qid for `question` scope, ignored for `common`.
 *  Returns the absolute path. */
export function resourceDir(
  scope: ResourceScope,
  key: string,
  category: ResourceCategory,
): string {
  const dir = categoryDir(scope, key, category);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve (creating it) a canonical sub-folder of `research/` — e.g. the
 *  `pdfs/` or `repos/` bucket for this scope. `subdir` should be one of
 *  RESEARCH_SUBDIRS; any other name is allowed but discouraged (path-guarded).
 *  This is the deterministic "where does a PDF go" call. */
export function researchSubdir(
  scope: ResourceScope,
  key: string,
  subdir: ResearchSubdir | string,
): string {
  safeName(subdir);
  const dir = join(categoryDir(scope, key, "research"), subdir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Scaffold the full layout for the common scope + the given persona, so the
 *  operator can see where to drop files. Idempotent. (Unchanged: the question
 *  scope is scaffolded on demand via ensureQuestionDirs.) */
export function ensureResourceDirs(personaId: string): void {
  for (const scope of ["common", "persona"] as const) {
    for (const category of RESOURCE_CATEGORIES) {
      mkdirSync(categoryDir(scope, personaId, category), { recursive: true });
    }
  }
}

/** Scaffold the question-scoped workspace: every category plus the canonical
 *  research sub-structure (downloads/pdfs/repos/sources/notes), ready for an
 *  agent to dump artifacts while investigating one question. Idempotent.
 *  Returns the question root (questions/<qid>/).
 *
 *  Pass a canonical backend qid (`qst_…`, lowercase crockford32 — slug-stable).
 *  The key is slugified for path safety (same guard as personaId), so two
 *  *non-canonical* keys differing only in case/separators would collapse to one
 *  folder; real qids never collide. */
export function ensureQuestionDirs(qid: string): string {
  for (const category of RESOURCE_CATEGORIES) {
    mkdirSync(categoryDir("question", qid, category), { recursive: true });
  }
  for (const sub of RESEARCH_SUBDIRS) {
    mkdirSync(join(categoryDir("question", qid, "research"), sub), {
      recursive: true,
    });
  }
  return join(resourceRoot(), "questions", slugify(qid));
}
