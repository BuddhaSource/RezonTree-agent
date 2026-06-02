// bootstrap/scaffold.ts — extend the swarm without touching a shipped file.
//
// `rt new <kind> <name>` writes a gitignored `.local` card from a template. The
// path-builder is pure and can ONLY ever produce a `<dir>/<slug>.local.md` path
// (slug validated — no `/`, no `..`), so the command structurally cannot target
// a shipped card or escape the content dirs. "Never edit the system file" is
// thus enforced by construction, not by convention. The writer (rt new) only
// adds an existence guard so a customization is never clobbered.

export type ScaffoldKind = "agent" | "skill" | "voice";

export interface Scaffold {
  kind: ScaffoldKind;
  /** target path, relative to repo root — ALWAYS a *.local.md under a content dir. */
  path: string;
  content: string;
}

/** Validate a card name is a safe slug (lowercase alnum + dashes). Rejects path
 *  traversal / separators so the scaffold can't escape its content dir. */
function slugify(name: string | undefined, kind: ScaffoldKind): string {
  const n = (name ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) {
    throw new Error(`rt new ${kind} <name> needs a slug name: lowercase letters, digits, dashes (got ${JSON.stringify(name)})`);
  }
  return n;
}

const agentTemplate = (slug: string): string =>
  `---
label: ${slug.charAt(0).toUpperCase() + slug.slice(1)}
weights:
  ask: 2
  solve: 4
  vote: 3
  cosponsor: 1
---
${slug}: a custom persona. Edit the weights above to set its action mix and this
body to give it a distinct voice. The how-to (post/vote procedure) is shared and
lives in the flow context — content is the only thing you change here.
`;

const skillTemplate = (slug: string): string =>
  `# ${slug.replace(/-/g, " ")}

Use when: <describe the moment a flow should inject this card>.

<your guidance here — facts, derivations, checks; this is content an agent reads,
not code it runs>.
`;

const voiceTemplate = (): string =>
  `Sharpened on @ReZonTree — <your distinct brand voice here>. High-quality,
trainable knowledge, forged by staked peer review. #RezonTree
`;

/** Pure: the target path + template content for a new `.local` card. */
export function scaffold(kind: ScaffoldKind, name?: string): Scaffold {
  switch (kind) {
    case "agent": {
      const slug = slugify(name, "agent");
      return { kind, path: `src/agents/${slug}.local.md`, content: agentTemplate(slug) };
    }
    case "skill": {
      const slug = slugify(name, "skill");
      return { kind, path: `src/skills/${slug}.local.md`, content: skillTemplate(slug) };
    }
    case "voice":
      return { kind, path: `src/social/share-voice.local.md`, content: voiceTemplate() };
    default:
      throw new Error(`unknown kind '${kind as string}' — use: agent | skill | voice`);
  }
}
