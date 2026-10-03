import { describe, expect, it } from "vite-plus/test";

import { HubAccountId, type HubThreadLink, HubThreadId, ThreadId } from "@t3tools/contracts";

import {
  isRelatedThreadOwner,
  relatedThreadOwnerLabel,
  resolveRelatedThreads,
} from "./relatedWork.ts";

const visibleId = ThreadId.make("thread-visible");
const hiddenId = ThreadId.make("thread-hidden");
const NOW = "2026-01-01T00:00:00.000Z";
const bobsMirror: HubThreadLink = {
  threadId: HubThreadId.make("link-bob:t1"),
  ownerId: HubAccountId.make("acct-bob"),
  ownerLogin: "bob",
  ownerDisplayName: "Bob",
  remote: true,
  syncState: "synced",
};

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
            hub: bobsMirror,
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
        hub: bobsMirror,
        status: "active",
      },
      {
        kind: "unavailable",
        link: { relatedThreadId: hiddenId, relationship: "alternative", linkedAt: NOW },
      },
    ]);
  });
});

describe("related thread ownership", () => {
  it("owns every local thread and no teammate mirror", () => {
    expect(isRelatedThreadOwner({})).toBe(true);
    expect(isRelatedThreadOwner({ hub: { ...bobsMirror, remote: false } })).toBe(true);
    expect(isRelatedThreadOwner({ hub: bobsMirror })).toBe(false);
    expect(relatedThreadOwnerLabel({})).toBe("you");
    expect(relatedThreadOwnerLabel({ hub: bobsMirror })).toBe("Bob");
  });
});
