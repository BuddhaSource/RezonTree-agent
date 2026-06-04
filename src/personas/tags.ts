// personas/tags.ts — derive search/discovery tags for a question from its
// specialization domain + the title's most specific words.
//
// Tags are an OFF-CHAIN field: the backend stores + searches them, but the
// signed SponsorWitness always carries empty tags (the preflight hashes them
// empty), so tags are decoupled from the intent hash and free to be rich.
// Empty tags = a question nobody can find by topic; deriving sensible ones is
// pure upside for discovery.

/** Curated domain tags per specialization id. The title-derived keywords add
 *  specificity on top. Unknown ids fall back to "general". */
const DOMAIN_TAGS: Record<string, string[]> = {
  "ai-alignment": ["ai-alignment", "ai-safety"],
  "distributed-systems": ["distributed-systems", "consensus"],
  "mechanism-design": ["mechanism-design", "incentives"],
  security: ["security", "cryptography"],
  prediction: ["prediction-markets", "forecasting"],
  general: ["open-problem"],
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "without", "under", "before", "after", "that",
  "this", "your", "you", "via", "into", "from", "what", "which", "will",
  "when", "where", "how", "are", "is", "of", "to", "in", "on", "by", "or",
  "a", "an", "its", "their", "best", "named", "specific",
]);

/** Backend caps tags at 5 (service/question.go MaxQuestionTags). */
export const MAX_QUESTION_TAGS = 5;

function slug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Derive up to 5 lowercase, deduped tags: the specialization's curated domain
 *  tags first, then the 1-2 longest (most specific) non-stopword title words. */
export function deriveQuestionTags(specializationId: string, title: string): string[] {
  const domain = DOMAIN_TAGS[specializationId] ?? DOMAIN_TAGS.general;
  const fromTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 5 && !STOPWORDS.has(w))
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...domain, ...fromTitle]) {
    const s = slug(raw);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
      if (out.length >= MAX_QUESTION_TAGS) break;
    }
  }
  return out;
}
