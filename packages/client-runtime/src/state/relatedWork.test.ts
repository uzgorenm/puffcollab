import { describe, expect, it } from "vite-plus/test";

import { MemberId, OWNER_MEMBER_ID, ThreadId } from "@t3tools/contracts";

import { isRelatedThreadOwner, resolveRelatedThreads } from "./relatedWork.ts";

const ada = MemberId.make("member-ada");
const visibleId = ThreadId.make("thread-visible");
const hiddenId = ThreadId.make("thread-hidden");
const NOW = "2026-01-01T00:00:00.000Z";

describe("resolveRelatedThreads", () => {
  it("shows visible threads and renders the rest as unavailable without details", () => {
    const resolved = resolveRelatedThreads(
      [
        { relatedThreadId: visibleId, relationship: "complementary", linkedAt: NOW },
        { relatedThreadId: hiddenId, relationship: "alternative", linkedAt: NOW },
      ],
      new Map([
        [
          visibleId,
          {
            id: visibleId,
            title: "Billing ledger",
            createdBy: ada,
            archivedAt: null,
            settledAt: null,
            session: null,
          },
        ],
      ]),
    );
    expect(resolved).toEqual([
      {
        kind: "visible",
        link: { relatedThreadId: visibleId, relationship: "complementary", linkedAt: NOW },
        title: "Billing ledger",
        createdBy: ada,
        status: "active",
      },
      {
        kind: "unavailable",
        link: { relatedThreadId: hiddenId, relationship: "alternative", linkedAt: NOW },
      },
    ]);
  });
});

describe("isRelatedThreadOwner", () => {
  it("treats ownerless threads as the environment owner's", () => {
    expect(isRelatedThreadOwner({ createdBy: null }, OWNER_MEMBER_ID)).toBe(true);
    expect(isRelatedThreadOwner({ createdBy: null }, ada)).toBe(false);
    expect(isRelatedThreadOwner({ createdBy: ada }, ada)).toBe(true);
    expect(isRelatedThreadOwner({ createdBy: ada }, null)).toBe(false);
  });
});
