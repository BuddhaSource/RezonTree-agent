// onboard.ts — the get-started flow behind `rt init`.
//
// Turns four answers (specialization, team size, blend, topics) into a
// concrete launch plan: a roster of named agents with personas + HD indices,
// the topic seeds they'll work, an env snippet to drive the swarm, the run
// command, and next steps — always nudging the operator to post a question
// they want crowdsourced (every question is new knowledge + reputation).
//
// buildOnboardPlan is PURE (fully unit-tested); runOnboard is the thin
// interactive shell (readline) with flag/env fallback so it works in a TTY,
// in CI, and from the swarm harness alike.

import { createInterface } from "node:readline/promises";

import {
  DEFAULT_SPECIALIZATION,
  resolvePersona,
  resolveSpecialization,
  SPECIALIZATIONS,
  type Persona,
  type Specialization,
} from "../personas/registry.js";

/** HD indices 1..9 are participants; 0 is reserved for the operator/oracle
 *  (matches the swarm POOL convention). Names are stable + human-friendly. */
export const AGENT_NAME_POOL = [
  "alice", "bob", "carol", "dave", "eve", "frank", "grace", "heidi", "ivan",
] as const;
export const MAX_TEAM_SIZE = AGENT_NAME_POOL.length;

/** How the persona roster is weighted across the team. */
export type Blend = "balanced" | "research" | "solve" | "vote";

/** The persona cycle each blend draws from, round-robin, to fill the team. */
const BLEND_CYCLES: Record<Blend, string[]> = {
  balanced: ["researcher", "solver", "solver", "voter"],
  research: ["researcher", "researcher", "solver", "voter"],
  solve: ["solver", "solver", "solver", "voter"],
  vote: ["voter", "voter", "solver", "researcher"],
};

export interface OnboardAnswers {
  specialization: string;
  teamSize: number;
  blend: Blend;
  /** Optional explicit topic list; falls back to the specialization seeds. */
  topics?: string[];
}

export interface RosterAgent {
  name: string;
  idx: number;
  persona: Persona;
}

export interface OnboardPlan {
  specialization: Specialization;
  blend: Blend;
  agents: RosterAgent[];
  topics: string[];
  /** Env lines to source before running the swarm. */
  envSnippet: string;
  /** The command that launches the configured swarm. */
  runCommand: string;
  /** Human next steps — funding, run, and the post-a-question nudge. */
  nextSteps: string[];
}

function clampTeamSize(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > MAX_TEAM_SIZE) return MAX_TEAM_SIZE;
  return Math.floor(n);
}

/** Pure: (answers) → launch plan. No IO, no env, no clock — fully testable. */
export function buildOnboardPlan(answers: OnboardAnswers): OnboardPlan {
  const specialization = resolveSpecialization(answers.specialization);
  const blend: Blend = BLEND_CYCLES[answers.blend] ? answers.blend : "balanced";
  const teamSize = clampTeamSize(answers.teamSize);
  const cycle = BLEND_CYCLES[blend];

  const agents: RosterAgent[] = [];
  for (let i = 0; i < teamSize; i++) {
    agents.push({
      name: AGENT_NAME_POOL[i],
      idx: i + 1, // HD index 1..N (0 reserved for operator)
      persona: resolvePersona(cycle[i % cycle.length]),
    });
  }

  const topics =
    answers.topics && answers.topics.length > 0
      ? answers.topics
      : specialization.topicSeeds;

  const names = agents.map((a) => a.name).join(",");
  const envSnippet = [
    `# RezonTree swarm — ${specialization.label} (${blend} blend, ${teamSize} agents)`,
    `export ORGANIC_AGENTS=${names}`,
    `export RT_SPECIALIZATION=${specialization.id}`,
    // RT_TOPICS is consumed by the swarm once Loop 7 wires specialization
    // topics in; harmless today.
    `export RT_TOPICS=${JSON.stringify(topics.join("|"))}`,
  ].join("\n");

  const runCommand = `node_modules/.bin/tsx scripts/organic-swarm.ts`;

  const nextSteps = [
    `Fund the ${teamSize} agent wallet(s) with USDC + a little ETH for gas (rt wallet list to see addresses; rt wallet topup --idx <n> on testnet).`,
    `Source the env above, then launch: ${runCommand}`,
    `Post a question you want the network to solve — every question is new knowledge + reputation: rt question post -f your-question.json (lens: ${specialization.qualityLens})`,
    `Watch progress + share a report with your humans: rt monitor (10-min heartbeat — coming in this campaign).`,
  ];

  return { specialization, blend, agents, topics, envSnippet, runCommand, nextSteps };
}

/** Render a plan as the human-facing get-started output. */
export function renderOnboardPlan(plan: OnboardPlan): string {
  const lines: string[] = [];
  lines.push(`\n  RezonTree get-started — ${plan.specialization.label}`);
  lines.push(`  ${"─".repeat(56)}`);
  lines.push(`  Team (${plan.agents.length}, ${plan.blend} blend):`);
  for (const a of plan.agents) {
    lines.push(`    • ${a.name.padEnd(7)} idx=${a.idx}  ${a.persona.label.padEnd(11)} ${a.persona.blurb}`);
  }
  lines.push(`\n  Topics to seed:`);
  for (const t of plan.topics) lines.push(`    • ${t}`);
  lines.push(`\n  Quality lens (what makes content trainable):`);
  lines.push(`    ${plan.specialization.qualityLens}`);
  lines.push(`\n  Env (source before launching):\n`);
  lines.push(plan.envSnippet.split("\n").map((l) => `    ${l}`).join("\n"));
  lines.push(`\n  Next steps:`);
  plan.nextSteps.forEach((s, i) => lines.push(`    ${i + 1}. ${s}`));
  lines.push("");
  return lines.join("\n");
}

export interface OnboardIO {
  /** Pre-supplied answers (CLI flags / env). Missing fields are prompted. */
  flags?: Partial<OnboardAnswers>;
  /** When false, never prompt — fill missing fields with defaults (CI). */
  interactive?: boolean;
}

/** Interactive shell: prompt for any answer not supplied via flags, build the
 *  plan, and return it (the caller renders + optionally writes an env file). */
export async function runOnboard(io: OnboardIO = {}): Promise<OnboardPlan> {
  const flags = io.flags ?? {};
  const interactive = io.interactive ?? process.stdin.isTTY === true;

  if (!interactive) {
    return buildOnboardPlan({
      specialization: flags.specialization ?? DEFAULT_SPECIALIZATION,
      teamSize: flags.teamSize ?? 3,
      blend: flags.blend ?? "balanced",
      topics: flags.topics,
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const specChoices = Object.keys(SPECIALIZATIONS);
    const specialization =
      (flags.specialization ??
        (await rl.question(
          `Specialization [${specChoices.join(" / ")}] (${DEFAULT_SPECIALIZATION}): `,
        ))) ||
      DEFAULT_SPECIALIZATION;
    const teamRaw =
      (flags.teamSize?.toString() ??
        (await rl.question(`Team size 1-${MAX_TEAM_SIZE} (3): `))) ||
      "3";
    const blendRaw =
      (flags.blend ??
        (await rl.question(`Blend [balanced / research / solve / vote] (balanced): `))) ||
      "balanced";
    const topicsRaw =
      flags.topics?.join("|") ??
      (await rl.question(`Topics (| separated, blank = use ${specialization} seeds): `));
    const topics = topicsRaw ? topicsRaw.split("|").map((t) => t.trim()).filter(Boolean) : undefined;

    return buildOnboardPlan({
      specialization,
      teamSize: Number(teamRaw),
      blend: blendRaw as Blend,
      topics,
    });
  } finally {
    rl.close();
  }
}
