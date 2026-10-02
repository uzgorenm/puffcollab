import { describe, expect, it } from "@effect/vitest";

import { rankRelatedWork, tokenize } from "./relatedWorkRanking.ts";

const candidate = (
  threadId: string,
  title: string,
  extra: { branch?: string; firstUserMessage?: string; updatedAt?: string } = {},
) => ({
  threadId,
  title,
  branch: extra.branch ?? null,
  firstUserMessage: extra.firstUserMessage ?? null,
  updatedAt: extra.updatedAt ?? "2026-01-01T00:00:00.000Z",
});

describe("tokenize", () => {
  it("lowercases, splits on punctuation, and drops short and stop words", () => {
    expect([...tokenize("Fix the OAuth login-redirect for /settings page, please")]).toEqual([
      "fix",
      "oauth",
      "login",
      "redirect",
      "settings",
      "page",
    ]);
  });
});

describe("rankRelatedWork", () => {
  const candidates = [
    candidate("t-message", "Unrelated title", {
      firstUserMessage: "the oauth login redirect loops",
    }),
    candidate("t-title", "OAuth login redirect loop"),
    candidate("t-branch", "Something else", { branch: "fix/oauth-login" }),
    candidate("t-none", "Dark mode colors"),
    candidate("t-one-word", "Login screen polish"),
  ];

  it("weights title over branch over first message and needs two shared words", () => {
    const ranked = rankRelatedWork("OAuth login redirect is broken", candidates, 5);
    expect(ranked.map((entry) => entry.candidate.threadId)).toEqual([
      "t-title",
      "t-branch",
      "t-message",
    ]);
    expect(ranked[0]?.matchedTerms).toEqual(["oauth", "login", "redirect"]);
  });

  it("is deterministic: equal scores order by recency, then id", () => {
    const tied = [
      candidate("b", "oauth login", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      candidate("a", "oauth login", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      candidate("c", "oauth login", { updatedAt: "2026-02-01T00:00:00.000Z" }),
    ];
    const first = rankRelatedWork("oauth login", tied, 3).map((entry) => entry.candidate.threadId);
    const reversed = rankRelatedWork("oauth login", tied.toReversed(), 3).map(
      (entry) => entry.candidate.threadId,
    );
    expect(first).toEqual(["c", "a", "b"]);
    expect(reversed).toEqual(first);
  });

  it("returns nothing for a draft with fewer than two meaningful words and honors the limit", () => {
    expect(rankRelatedWork("the oauth", candidates, 5)).toEqual([]);
    expect(rankRelatedWork("oauth login redirect", candidates, 1)).toHaveLength(1);
  });
});
