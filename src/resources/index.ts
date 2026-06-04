// resources/ — the agent working directory.
//
// A Django-style two-level file tree an agent reads as ONE merged view:
//
//   <RT_RESOURCE_DIR>/                      (default ./rezontree-files)
//     common/<category>/...                 shared by every agent
//     personas/<personaId>/<category>/...   per-persona overlay
//
// On read we walk BOTH levels and merge: a persona-level entry shadows a
// common entry of the same name (the same "local wins" rule as the
// {name}.local.md card overlay in skills/load.ts). So an agent always sees
// the shared files PLUS its own, and chooses scope by where it writes:
// drop a file in common/ and every agent gets it; drop it under its
// persona and only that persona does.
//
// Categories are just folders — `tools/` for downloadable tools/code (e.g.
// a Polymarket research helper an agent runs instead of building one),
// `research/` for gathered material, `working/` for scratch/working files.
// Entries can be files OR directories (a cloned GitHub repo is a dir).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** Shipped default categories. Extensible — any folder under a level is
 *  picked up; these are the ones the SDK scaffolds and documents. */
export const RESOURCE_CATEGORIES = ["tools", "research", "working"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export type ResourceScope = "common" | "persona";

export interface ResourceEntry {
  /** Base name (file or directory). */
  name: string;
  /** Absolute path on disk. */
  path: string;
  /** Which level it came from. */
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

/** Lowercase, separator-free slug so a personaId can never escape its
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

function categoryDir(
  scope: ResourceScope,
  personaId: string,
  category: ResourceCategory,
): string {
  const root = resourceRoot();
  return scope === "common"
    ? join(root, "common", category)
    : join(root, "personas", slugify(personaId), category);
}

/** List entries for (persona, category) as ONE merged view of common +
 *  persona. A persona-level entry shadows a common entry of the same name.
 *  Returns files and directories, sorted by name. Missing dirs are skipped. */
export function listResources(
  personaId: string,
  category: ResourceCategory,
): ResourceEntry[] {
  const byName = new Map<string, ResourceEntry>();
  // common first, persona second → persona overwrites on a name clash.
  for (const scope of ["common", "persona"] as const) {
    const dir = categoryDir(scope, personaId, category);
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

/** Read a named file: persona-level first, then common (local wins).
 *  Returns null if absent in both. */
export function readResource(
  personaId: string,
  category: ResourceCategory,
  name: string,
): string | null {
  safeName(name);
  for (const scope of ["persona", "common"] as const) {
    const path = join(categoryDir(scope, personaId, category), name);
    if (existsSync(path) && statSync(path).isFile()) {
      return readFileSync(path, "utf8");
    }
  }
  return null;
}

/** Resolve (creating it) the directory to WRITE into — download a tool,
 *  clone a repo, save research — at the chosen scope. `common` → every
 *  agent; `persona` → just this persona. Returns the absolute path. */
export function resourceDir(
  scope: ResourceScope,
  personaId: string,
  category: ResourceCategory,
): string {
  const dir = categoryDir(scope, personaId, category);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Scaffold the full layout (common + the given persona) so the operator
 *  can see where to drop files. Idempotent. */
export function ensureResourceDirs(personaId: string): void {
  for (const scope of ["common", "persona"] as const) {
    for (const category of RESOURCE_CATEGORIES) {
      mkdirSync(categoryDir(scope, personaId, category), { recursive: true });
    }
  }
}
