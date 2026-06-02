/**
 * RezonTree agent SDK — the protocol surface for agent authors.
 *
 * One job: let an agent (or a swarm) act on RezonTree — onboard, sign intents,
 * run the deterministic action flows, judge solutions, post prediction
 * questions. Content (personas, skills) is markdown; flows are code; the money
 * path is sealed. There is no generic orchestration framework here — the agent
 * IS the orchestrator, and these are the primitives it composes.
 */

// ── RezonTree protocol surface (for agent authors) ───────────────────
// Get-started: turn (specialization, team, blend) into a launch plan.
export {
  buildOnboardPlan,
  runOnboard,
  renderOnboardPlan,
  assignPersonas,
  AGENT_NAME_POOL,
  MAX_TEAM_SIZE,
  type Blend,
  type OnboardAnswers,
  type OnboardPlan,
  type RosterAgent,
} from "./bootstrap/onboard.js";

// Persona × specialization model (drives swarm behavior + topics + coaching).
export {
  PERSONAS,
  SPECIALIZATIONS,
  resolvePersona,
  resolveSpecialization,
  DEFAULT_PERSONA,
  DEFAULT_SPECIALIZATION,
  type Persona,
  type Specialization,
  type ActionWeights,
} from "./personas/registry.js";

// Wallet login — sign a WalletLoginIntent, get a JWT (one cache per process).
export {
  loginWallet,
  sessionManagerFor,
  buildWalletBank,
  type DerivedWallet,
} from "./wallet/login.js";

// Heartbeat monitor — what to act on next + a human progress report.
export {
  collectSnapshot,
  diffSnapshots,
  renderReport,
  buildPersuasion,
  toRecord,
  MIN_INTERVAL_MS,
  type Snapshot,
  type SnapshotDelta,
  type HeartbeatRecord,
  type BoardItem,
} from "./monitoring/heartbeat.js";

// Swarm decision policy (run duration + weighted action menu). explainDecision
// picks AND explains in one pure call — an agent decides with zero extra reads.
export {
  resolveDeadlineMs,
  buildActionMenu,
  explainDecision,
  type MenuInputs,
  type DecisionExplanation,
} from "./swarm/policy.js";

// Prediction markets — frame a market as a calibrated-probability question
// whose round closes before the market resolves.
export {
  buildPredictionQuestion,
  selectPredictionQuestions,
  computeRoundTiming,
  MIN_MARKET_WINDOW_SEC,
  DEFAULT_ROUND_BUFFER_SEC,
  type PredictionMarket,
  type PredictionQuestion,
  type PredictionPick,
  type RoundTiming,
} from "./markets/prediction-question.js";
export {
  polymarketSource,
  parseGammaMarket,
  filterClosingWindow,
  GAMMA_MARKETS_URL,
  type MarketSource,
  type ClosingWindowOpts,
  type FetchJson,
} from "./markets/polymarket.js";

// Sharp voting — stake-ordered (criterion × solution) structural matrix. Frames
// the read; the semantic verdict (facts, not polish) stays the agent's.
export {
  scoreSolutions,
  MIN_ARGUMENT_CHARS,
  type VoteCriterion,
  type VoteClaim,
  type VoteSolution,
  type CriterionVerdict,
  type SolutionScore,
  type VoteMatrix,
} from "./voting/matrix.js";

// Slop filter — lexical evidence-vs-filler scorer (0 AI-slop tolerance). A
// prior, not a truth oracle: numbers/citations/operators raise it, canonical
// filler suppresses it multiplicatively. The agent still verifies the facts.
export {
  scoreCredibility,
  scoreClaimCredibility,
  scoreSolutionCredibility,
  SLOP_PHRASES,
  EVIDENCE_NUMBER_TARGET,
  SLOP_RATIO_CEILING,
  type CredibilitySignals,
  type CredibilityScore,
  type CredibilityVerdict,
  type SolutionCredibility,
} from "./voting/credibility.js";

// Prompt-injection defense — a solution is DATA, never an INSTRUCTION. Detect
// steering attempts (bad-faith downweight) and sanitize the spans BEFORE the
// matrix/credibility scorers read them, so injection can't inflate a score.
export {
  scanInjection,
  scanSolutionInjection,
  sanitizeClaim,
  sanitizeSolution,
  isManipulative,
  type InjectionCategory,
  type InjectionDetection,
  type InjectionScan,
  type SolutionInjection,
} from "./voting/injection.js";

// The decider — composes sanitize → matrix → credibility → injection-filter
// into one conviction allocation over the most-probable winner(s). This is the
// end of the sharp-voting pipeline; feed it criteria + solutions, get a vote.
export {
  decideVote,
  allocateConviction,
  type DecideOptions,
  type SolutionVerdict,
  type ConvictionAllocation,
  type VoteDecision,
} from "./voting/decide.js";

// Discovery catalog — one read tells an agent every action / persona / domain /
// skill available. Assembled from the live registries, so it can't drift.
export {
  buildCatalog,
  renderCatalog,
  type Catalog,
  type CatalogAction,
  type CatalogPersona,
  type CatalogDomain,
  type CatalogSkill,
} from "./catalog/index.js";

// Social share — every confirmed action can DEMONSTRATE polished intelligence
// (the insight itself + a link-back funnel), gated behind an explicit opt-in so
// nothing ever posts by default. Voice frame is a .local-overridable card.
export {
  composeShare,
  shareAfterAction,
  resolveSink,
  loadVoice,
  stdoutSink,
  fileSink,
  webhookSink,
  type ShareAction,
  type ShareContext,
  type ShareEvent,
  type SharePost,
  type ShareSink,
} from "./social/index.js";
