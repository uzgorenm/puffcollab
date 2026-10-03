import {
  HubAccountId,
  HubEnvironmentLinkId,
  HubInvitationId,
  type HubLocalInvitation,
  type HubLocalStatus,
  HubProjectId,
  HubThreadId,
  type HubThreadLink,
  ProjectId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupHubInvitations,
  hasPendingHubInvitation,
  hubConnectionLabel,
  hubLinkedProjectsKey,
  hubProjectLinkOf,
  hubStatusSummary,
  hubSyncIndicator,
  isHubLinked,
  isProjectInHubKey,
  parseGithubLoginInput,
  parseHubUrlInput,
} from "./hub.ts";

const status = (overrides: Partial<HubLocalStatus> = {}): HubLocalStatus => ({
  state: "unlinked",
  hubUrl: null,
  account: null,
  linkId: null,
  pendingLink: null,
  projects: [],
  queuedEvents: 0,
  lastError: null,
  ...overrides,
});

const account = {
  accountId: HubAccountId.make("acct-1"),
  githubLogin: "octo",
  displayName: "Octo Cat",
};

const projectA = ProjectId.make("project-a");
const hubA = HubProjectId.make("hub-a");
const hubB = HubProjectId.make("hub-b");

const invitation = (
  id: string,
  overrides: Partial<HubLocalInvitation> = {},
): HubLocalInvitation => ({
  invitationId: HubInvitationId.make(id),
  hubProjectId: hubA,
  projectTitle: "Alpha",
  inviterLogin: "octo",
  inviteeLogin: "ada",
  direction: "incoming",
  state: "pending",
  createdAt: "2026-10-01T10:00:00.000Z",
  expiresAt: "2026-10-15T10:00:00.000Z",
  ...overrides,
});

const NOW = "2026-10-02T00:00:00.000Z";

describe("hub status", () => {
  it("labels every connection state", () => {
    expect(hubConnectionLabel("online")).toBe("Connected");
    expect(hubConnectionLabel("version-mismatch")).toBe("Update needed");
    expect(hubStatusSummary(null)).toMatchObject({ label: "Loading", tone: "neutral" });
  });

  it("explains what to do next and how much is queued", () => {
    expect(hubStatusSummary(status()).detail).toMatch(/hub address/);
    expect(hubStatusSummary(status({ hubUrl: "https://hub.test" })).detail).toMatch(/Link this/);
    expect(hubStatusSummary(status({ state: "online" })).detail).toBeNull();
    expect(hubStatusSummary(status({ state: "offline", queuedEvents: 3 }))).toMatchObject({
      tone: "attention",
      detail: "Can't reach the hub. 3 updates will sync when it's back.",
    });
    expect(hubStatusSummary(status({ state: "online", queuedEvents: 1 })).detail).toBe(
      "1 update syncing.",
    );
    expect(
      hubStatusSummary(status({ state: "error", lastError: "Link revoked on the hub." })),
    ).toMatchObject({ tone: "critical", detail: "Link revoked on the hub." });
    expect(hubStatusSummary(status({ state: "version-mismatch" })).detail).toMatch(/Update/);
  });

  it("knows when the environment is linked and which project is on the hub", () => {
    expect(isHubLinked(status())).toBe(false);
    expect(isHubLinked(null)).toBe(false);
    const linked = status({
      state: "offline",
      account,
      linkId: HubEnvironmentLinkId.make("link-1"),
      projects: [{ projectId: projectA, hubProjectId: hubA, hubProjectTitle: "Alpha" }],
    });
    expect(isHubLinked(linked)).toBe(true);
    expect(hubProjectLinkOf(linked, projectA)?.hubProjectId).toBe(hubA);
    expect(hubProjectLinkOf(linked, ProjectId.make("other"))).toBeNull();
    expect(hubProjectLinkOf(undefined, projectA)).toBeNull();
    const key = hubLinkedProjectsKey(linked);
    expect(isProjectInHubKey(key, projectA)).toBe(true);
    expect(isProjectInHubKey(key, ProjectId.make("project"))).toBe(false);
    expect(isProjectInHubKey(hubLinkedProjectsKey(null), projectA)).toBe(false);
  });
});

describe("hub inputs", () => {
  it("accepts an http(s) hub address, trims trailing slashes, and clears on empty", () => {
    expect(parseHubUrlInput("  ")).toEqual({ ok: true, hubUrl: null });
    expect(parseHubUrlInput(" https://hub.example.com/ ")).toEqual({
      ok: true,
      hubUrl: "https://hub.example.com",
    });
    expect(parseHubUrlInput("http://192.168.1.4:8787")).toEqual({
      ok: true,
      hubUrl: "http://192.168.1.4:8787",
    });
    expect(parseHubUrlInput("hub.example.com").ok).toBe(false);
    expect(parseHubUrlInput("ftp://hub.example.com").ok).toBe(false);
    expect(parseHubUrlInput("https://hub.example.com/?x=1").ok).toBe(false);
  });

  it("parses GitHub logins with or without @", () => {
    expect(parseGithubLoginInput(" @Octo-Cat ")).toBe("Octo-Cat");
    expect(parseGithubLoginInput("-bad")).toBeNull();
    expect(parseGithubLoginInput("has space")).toBeNull();
    expect(parseGithubLoginInput("")).toBeNull();
  });
});

describe("hub thread sync", () => {
  const link = (overrides: Partial<HubThreadLink>): HubThreadLink => ({
    threadId: HubThreadId.make("link-1:t"),
    ownerId: HubAccountId.make("acct-1"),
    ownerLogin: "octo",
    ownerDisplayName: "Octo",
    remote: false,
    syncState: "synced",
    ...overrides,
  });

  it("marks own hub threads and leaves remote mirrors and local threads alone", () => {
    expect(hubSyncIndicator({ hub: link({ syncState: "offline" }) })).toMatchObject({
      state: "offline",
    });
    expect(hubSyncIndicator({ hub: link({ remote: true }) })).toBeNull();
    expect(hubSyncIndicator({})).toBeNull();
  });
});

describe("hub invitations", () => {
  it("splits pending invitations into incoming and outgoing per project, newest first", () => {
    const groups = groupHubInvitations(
      [
        invitation("old-in", { createdAt: "2026-09-30T00:00:00.000Z" }),
        invitation("new-in", { createdAt: "2026-10-01T12:00:00.000Z" }),
        invitation("out-a", { direction: "outgoing" }),
        invitation("out-b", { direction: "outgoing", hubProjectId: hubB }),
        invitation("answered", { state: "declined" }),
        invitation("expired", { expiresAt: "2026-10-01T00:00:00.000Z" }),
      ],
      NOW,
    );
    expect(groups.incoming.map((entry) => entry.invitationId)).toEqual(["new-in", "old-in"]);
    expect(groups.outgoingByProject.get(hubA)?.map((entry) => entry.invitationId)).toEqual([
      "out-a",
    ]);
    expect(groups.outgoingByProject.get(hubB)).toHaveLength(1);
    expect(groupHubInvitations(null, NOW).incoming).toEqual([]);
  });

  it("matches pending invitees case-insensitively", () => {
    const outgoing = [invitation("out", { direction: "outgoing", inviteeLogin: "Ada" })];
    expect(hasPendingHubInvitation(outgoing, "ada")).toBe(true);
    expect(hasPendingHubInvitation(outgoing, "bob")).toBe(false);
  });
});
