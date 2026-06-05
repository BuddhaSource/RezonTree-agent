import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureQuestionDirs,
  ensureResourceDirs,
  listResources,
  readResource,
  RESEARCH_SUBDIRS,
  RESOURCE_CATEGORIES,
  researchSubdir,
  resourceDir,
  resourceRoot,
} from "./index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rt-resources-"));
  process.env.RT_RESOURCE_DIR = root;
});

afterEach(() => {
  delete process.env.RT_RESOURCE_DIR;
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

describe("resources working directory", () => {
  it("merges common + persona into one view", () => {
    write("common/research/shared.md", "shared");
    write("personas/researcher/research/mine.md", "mine");
    const names = listResources("researcher", "research").map((e) => e.name);
    expect(names).toEqual(["mine.md", "shared.md"]);
  });

  it("persona entry shadows a common entry of the same name", () => {
    write("common/tools/poly.ts", "common version");
    write("personas/solver/tools/poly.ts", "persona version");
    const entries = listResources("solver", "tools");
    expect(entries).toHaveLength(1);
    expect(entries[0].scope).toBe("persona");
    expect(readResource("solver", "tools", "poly.ts")).toBe("persona version");
  });

  it("readResource falls back to common when persona has none", () => {
    write("common/working/notes.md", "from common");
    expect(readResource("voter", "working", "notes.md")).toBe("from common");
  });

  it("readResource returns null when absent in both levels", () => {
    expect(readResource("voter", "working", "nope.md")).toBeNull();
  });

  it("lists directories (e.g. a cloned repo) as well as files", () => {
    mkdirSync(join(root, "personas", "researcher", "tools", "some-repo"), {
      recursive: true,
    });
    write("personas/researcher/tools/run.ts", "x");
    const entries = listResources("researcher", "tools");
    expect(entries.find((e) => e.name === "some-repo")?.kind).toBe("dir");
    expect(entries.find((e) => e.name === "run.ts")?.kind).toBe("file");
  });

  it("rejects path-traversal names", () => {
    expect(() => readResource("x", "working", "../../etc/passwd")).toThrow(
      /unsafe/,
    );
  });

  it("slugifies the persona id so it can't escape its folder", () => {
    // A hostile id collapses to a safe slug; the write lands under the root.
    const dir = resourceDir("persona", "../../evil id!", "working");
    expect(dir.startsWith(resourceRoot())).toBe(true);
  });

  it("ensureResourceDirs scaffolds every category at both levels", () => {
    ensureResourceDirs("researcher");
    for (const cat of RESOURCE_CATEGORIES) {
      // common + persona dirs exist → listing doesn't throw, returns [].
      expect(listResources("researcher", cat)).toEqual([]);
    }
  });

  it("empty / missing dirs list as empty, not error", () => {
    expect(listResources("nobody", "research")).toEqual([]);
  });

  // ── question scope (the "very specific" tier) ──

  it("question scope folds in as the most-specific tier, shadowing persona + common", () => {
    write("common/research/a.md", "common");
    write("personas/researcher/research/b.md", "persona");
    write("questions/qst_abc/research/a.md", "question wins");
    write("questions/qst_abc/research/c.md", "question only");
    const entries = listResources("researcher", "research", "qst_abc");
    const byName = Object.fromEntries(entries.map((e) => [e.name, e.scope]));
    // a.md present in common AND question → question shadows.
    expect(byName["a.md"]).toBe("question");
    expect(byName["b.md"]).toBe("persona");
    expect(byName["c.md"]).toBe("question");
    // Without the qid, the question tier is invisible (back-compat).
    expect(listResources("researcher", "research").map((e) => e.name)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("readResource prefers question > persona > common when a qid is given", () => {
    write("common/research/x.md", "from common");
    write("personas/solver/research/x.md", "from persona");
    write("questions/qst_z/research/x.md", "from question");
    // Most-specific tier wins.
    expect(readResource("solver", "research", "x.md", "qst_z")).toBe(
      "from question",
    );
    // No question copy → falls back to persona (a different question's tier
    // is empty, so persona shadows common).
    write("personas/solver/research/p.md", "persona only");
    expect(readResource("solver", "research", "p.md", "qst_z")).toBe(
      "persona only",
    );
    // Absent everywhere → null.
    expect(readResource("solver", "research", "missing.md", "qst_z")).toBeNull();
  });

  it("ensureQuestionDirs scaffolds every category + the research sub-structure", () => {
    const qroot = ensureQuestionDirs("qst_scaffold");
    expect(qroot.startsWith(resourceRoot())).toBe(true);
    // tools/ + working/ scaffolded but empty.
    expect(listResources("nobody", "tools", "qst_scaffold")).toEqual([]);
    expect(listResources("nobody", "working", "qst_scaffold")).toEqual([]);
    // research/ carries the canonical sub-structure (order-independent).
    const subdirs = listResources("nobody", "research", "qst_scaffold");
    expect(subdirs.every((e) => e.kind === "dir")).toBe(true);
    expect(subdirs.map((e) => e.name).sort()).toEqual([...RESEARCH_SUBDIRS].sort());
  });

  it("researchSubdir resolves a canonical research bucket, path-guarded", () => {
    const pdfs = researchSubdir("question", "qst_pdf", "pdfs");
    expect(pdfs.startsWith(resourceRoot())).toBe(true);
    expect(pdfs.endsWith(join("research", "pdfs"))).toBe(true);
    expect(() => researchSubdir("common", "x", "../escape")).toThrow(/unsafe/);
  });

  it("resourceDir writes into the question scope", () => {
    const dir = resourceDir("question", "qst_w", "tools");
    expect(dir.startsWith(resourceRoot())).toBe(true);
    expect(dir.includes(join("questions", "qst_w", "tools"))).toBe(true);
  });
});
