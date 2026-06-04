// orchestration/types.ts — the Flow contract.
//
// A FLOW is DETERMINISTIC control flow expressed as CODE (not a markdown card):
// a fixed sequence of steps that the framework runs identically for every
// agent. The only per-agent inputs a flow receives are the agent's CONTENT
// (its card) and its weights — never a different code path. This is the
// "one flow, many contents" rule that keeps drift low: agents vary in what
// they know and how often they act, never in HOW an action executes.
//
// Each flow DECLARES its `context` — the exact named cards (skills/prompts)
// that belong in the agent's prompt for this action. Naming the read-set in
// code, instead of letting the agent scan a folder and guess, is what makes
// context loading deterministic. The registry fence asserts every named card
// exists on disk, so the declaration can never dangle.
//
// FlowCtx carries every runtime dependency a flow needs — config, clients, the
// HTTP helpers — so a flow captures nothing from module scope and can be run or
// tested in isolation.

import { createPublicClient, type Address } from "viem";

import { makeAgentWalletClient } from "../forge/quadphase-broadcast.js";
import type { Persona } from "../personas/registry.js";
import type { ShareEvent } from "../social/index.js";
import type { VoteSolution } from "../voting/matrix.js";
import type { AgentWallet } from "../wallet/types.js";

export type ActionKind = "ask" | "solve" | "vote" | "cosponsor";

export interface OpenQ {
  id: string;
  author: string;
  title: string;
}

/** A swarm agent — identity + content (persona) + per-run history. */
export interface Agent {
  name: string;
  persona: Persona; // role + action-weight profile (researcher/solver/voter/…)
  wallet: AgentWallet;
  address: Address;
  token: string;
  sponsored: Set<string>;
  solved: Set<string>;
  voted: Set<string>;
  cosponsored: Set<string>;
  acts: Record<string, number>; // action -> count
  broke: boolean; // true once a funded action reverted on insufficient funds — pause funded actions
}

/** Resolved runtime config a flow needs (no env reads inside flows). */
export interface SwarmConfig {
  backend: string;
  rpc: string;
  chainId: number;
  forge: Address;
  usdc: Address;
  sponsorAmount: string;
  initialBounty: string;
  topics: { title: string; framing: string; tags?: string[] }[];
}

/** Everything a flow captures from the harness — passed in, never global. */
export interface FlowCtx {
  cfg: SwarmConfig;
  publicClient: ReturnType<typeof createPublicClient>;
  makeWc(w: AgentWallet): ReturnType<typeof makeAgentWalletClient>;
  call<T = any>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }>;
  preflight<T>(qid: string, actionType: string, callerKey: string, caller: Address, token: string): Promise<T>;
  log(name: string, m: string): void;
  /** Optional after-action hook — emit a social share for a CONFIRMED action.
   *  Undefined unless the operator opts in (RT_SOCIAL_SHARE=1); never throws the
   *  flow (a share failure must not undo a settled on-chain action). */
  share?(ev: ShareEvent): Promise<void>;
}

/** Vote needs both the question and its (already-fetched) candidate solutions. */
export interface VoteTarget {
  q: OpenQ;
  sols: VoteSolution[];
}

/**
 * A deterministic flow. `run` is shared by every agent; `target` is the
 * per-tick subject (a question to solve/cosponsor, a question+solutions to vote
 * on, or nothing for ask). `context` is the declared read-set for this flow.
 */
export interface Flow<Target = void> {
  name: ActionKind;
  /** one line — what this action does + when to pick it. Surfaced in the
   *  discovery catalog so an agent chooses without reading the flow code. */
  summary: string;
  /** named cards that belong in the agent's prompt for this action. */
  context: readonly string[];
  run(agent: Agent, target: Target, ctx: FlowCtx): Promise<void>;
}
