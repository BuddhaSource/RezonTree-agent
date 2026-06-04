import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureResourceDirs,
  listResources,
  readResource,
  RESOURCE_CATEGORIES,
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
});
