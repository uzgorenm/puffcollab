/**
 * Deterministic, provider-free ranking for related-work suggestions: word
 * overlap between a draft and each candidate thread's title, branch name, and
 * first user message. Cheap enough to run on every debounced keystroke.
 *
 * @module relatedWorkRanking
 */

// Words so common in coding requests that sharing them says nothing.
const STOP_WORDS = new Set([
  "a",
  "about",
  "add",
  "after",
  "all",
  "also",
  "and",
  "any",
  "are",
  "because",
  "been",
  "before",
  "but",
  "can",
  "could",
  "does",
  "doing",
  "don",
  "each",
  "for",
  "from",
  "get",
  "had",
  "has",
  "have",
  "how",
  "into",
  "its",
  "just",
  "let",
  "lets",
  "like",
  "make",
  "need",
  "not",
  "now",
  "only",
  "our",
  "out",
  "please",
  "should",
  "some",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "this",
  "use",
  "using",
  "want",
  "was",
  "way",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const MIN_TOKEN_LENGTH = 3;
/** A suggestion must share at least this many distinct words with the draft. */
const MIN_MATCHED_TERMS = 2;
const MAX_MATCHED_TERMS_SHOWN = 5;
const TITLE_WEIGHT = 3;
const BRANCH_WEIGHT = 2;
const MESSAGE_WEIGHT = 1;

/** Lowercase words of at least three letters or digits, minus stop words. */
export const tokenize = (text: string): ReadonlySet<string> => {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(raw)) {
      tokens.add(raw);
    }
  }
  return tokens;
};

export interface RelatedWorkCandidate {
  readonly threadId: string;
  readonly title: string;
  readonly branch: string | null;
  readonly firstUserMessage: string | null;
  readonly updatedAt: string;
}

export interface RankedRelatedWork<C extends RelatedWorkCandidate> {
  readonly candidate: C;
  readonly score: number;
  readonly matchedTerms: ReadonlyArray<string>;
}

/**
 * Rank candidates by weighted word overlap with the draft. Ties go to the
 * more recently updated thread, then to the lower thread id, so the same
 * inputs always produce the same order.
 */
export const rankRelatedWork = <C extends RelatedWorkCandidate>(
  draft: string,
  candidates: ReadonlyArray<C>,
  limit: number,
): ReadonlyArray<RankedRelatedWork<C>> => {
  const draftTokens = tokenize(draft);
  if (draftTokens.size < MIN_MATCHED_TERMS) return [];
  const ranked: Array<RankedRelatedWork<C>> = [];
  for (const candidate of candidates) {
    const titleTokens = tokenize(candidate.title);
    const branchTokens = tokenize(candidate.branch ?? "");
    const messageTokens = tokenize(candidate.firstUserMessage ?? "");
    let score = 0;
    const matchedTerms: string[] = [];
    // Iterating the draft keeps matchedTerms in the order the user wrote them.
    for (const token of draftTokens) {
      const weight = titleTokens.has(token)
        ? TITLE_WEIGHT
        : branchTokens.has(token)
          ? BRANCH_WEIGHT
          : messageTokens.has(token)
            ? MESSAGE_WEIGHT
            : 0;
      if (weight === 0) continue;
      score += weight;
      matchedTerms.push(token);
    }
    if (matchedTerms.length < MIN_MATCHED_TERMS) continue;
    ranked.push({
      candidate,
      score,
      matchedTerms: matchedTerms.slice(0, MAX_MATCHED_TERMS_SHOWN),
    });
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      (left.candidate.updatedAt < right.candidate.updatedAt
        ? 1
        : left.candidate.updatedAt > right.candidate.updatedAt
          ? -1
          : 0) ||
      (left.candidate.threadId < right.candidate.threadId ? -1 : 1),
  );
  return ranked.slice(0, limit);
};
