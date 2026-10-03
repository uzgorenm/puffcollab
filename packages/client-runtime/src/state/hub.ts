import {
  type EnvironmentId,
  type HubConnectionState,
  type HubLocalInvitation,
  type HubLocalProjectLink,
  type HubLocalStatus,
  type HubProjectId,
  type HubThreadLink,
  isRemoteHubThread,
  normalizeGithubLogin,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * The team hub (Stage 7) as one environment's local server sees it: its
 * connection status and the viewer's hub invitations, both pushed by the
 * server, plus the commands that change them. Clients only talk to their own
 * local server, which forwards to the hub; reads are streams, so commands
 * need no refetch.
 */
export function createHubEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  const command = <TTag extends HubCommandTag>(name: string, tag: TTag) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:hub:${name}`,
      tag,
      scheduler,
      concurrency,
    });
  const status = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:hub:status",
    tag: WS_METHODS.hubSubscribeStatus,
  });
  return {
    /** The local server's hub connection, now and after every change. */
    status,
    /**
     * The hub-linked local projects as a stable string (see
     * `isProjectInHubKey`), so per-row readers don't re-render on every
     * status push (queue counts change often while syncing).
     */
    linkedProjectsKey: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) =>
        hubLinkedProjectsKey(
          Option.getOrNull(AsyncResult.value(get(status({ environmentId, input: {} })))),
        ),
      ).pipe(Atom.withLabel(`environment-data:hub:linked-projects:${environmentId}`)),
    ),
    /** Incoming and outgoing hub invitations, now and after every change. */
    invitations: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hub:invitations",
      tag: WS_METHODS.hubSubscribeInvitations,
    }),
    configure: command("configure", WS_METHODS.hubConfigure),
    linkStart: command("link-start", WS_METHODS.hubLinkStart),
    linkCancel: command("link-cancel", WS_METHODS.hubLinkCancel),
    unlink: command("unlink", WS_METHODS.hubUnlink),
    linkProject: command("link-project", WS_METHODS.hubLinkProject),
    unlinkProject: command("unlink-project", WS_METHODS.hubUnlinkProject),
    invite: command("invite", WS_METHODS.hubInvite),
    respondInvitation: command("respond-invitation", WS_METHODS.hubRespondInvitation),
    cancelInvitation: command("cancel-invitation", WS_METHODS.hubCancelInvitation),
    /** A linked project's hub team (members, and the overview in Team overview). */
    team: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:hub:team",
      tag: WS_METHODS.hubSubscribeTeam,
      idleTtlMs: 30_000,
    }),
    removeMember: command("remove-member", WS_METHODS.hubRemoveMember),
    leaveProject: command("leave-project", WS_METHODS.hubLeaveProject),
    updateBrief: command("update-brief", WS_METHODS.hubUpdateBrief),
    setFocus: command("set-focus", WS_METHODS.hubSetFocus),
  };
}

type HubCommandTag =
  | typeof WS_METHODS.hubConfigure
  | typeof WS_METHODS.hubLinkStart
  | typeof WS_METHODS.hubLinkCancel
  | typeof WS_METHODS.hubUnlink
  | typeof WS_METHODS.hubLinkProject
  | typeof WS_METHODS.hubUnlinkProject
  | typeof WS_METHODS.hubInvite
  | typeof WS_METHODS.hubRespondInvitation
  | typeof WS_METHODS.hubCancelInvitation
  | typeof WS_METHODS.hubRemoveMember
  | typeof WS_METHODS.hubLeaveProject
  | typeof WS_METHODS.hubUpdateBrief
  | typeof WS_METHODS.hubSetFocus;

/** Shown as a hint in the hub URL field; never used as a value. */
export const HUB_URL_PLACEHOLDER = "https://puffcollab-hub.<subdomain>.workers.dev";

export type HubStatusTone = "neutral" | "positive" | "attention" | "critical";

const CONNECTION_LABELS: Record<HubConnectionState, string> = {
  unlinked: "Not linked",
  linking: "Waiting for approval",
  connecting: "Connecting",
  online: "Connected",
  offline: "Offline",
  "version-mismatch": "Update needed",
  error: "Needs attention",
};

const CONNECTION_TONES: Record<HubConnectionState, HubStatusTone> = {
  unlinked: "neutral",
  linking: "neutral",
  connecting: "neutral",
  online: "positive",
  offline: "attention",
  "version-mismatch": "critical",
  error: "critical",
};

export function hubConnectionLabel(state: HubConnectionState): string {
  return CONNECTION_LABELS[state];
}

export interface HubStatusSummary {
  readonly label: string;
  readonly tone: HubStatusTone;
  /** One sentence explaining the state, or null when the label says enough. */
  readonly detail: string | null;
}

function pluralUpdates(count: number): string {
  return count === 1 ? "1 update" : `${count} updates`;
}

/** The status line for settings: a label, a tone, and an explanation. */
export function hubStatusSummary(status: HubLocalStatus | null | undefined): HubStatusSummary {
  if (!status) return { label: "Loading", tone: "neutral", detail: null };
  const label = hubConnectionLabel(status.state);
  const tone = CONNECTION_TONES[status.state];
  switch (status.state) {
    case "unlinked":
      return {
        label,
        tone,
        detail:
          status.hubUrl === null
            ? "Enter your team's hub address to sync shared threads with teammates."
            : "Link this computer to your hub account to start syncing.",
      };
    case "linking":
      return { label, tone, detail: "Approve the code on the hub to finish linking." };
    case "online":
      return {
        label,
        tone,
        detail: status.queuedEvents > 0 ? `${pluralUpdates(status.queuedEvents)} syncing.` : null,
      };
    case "offline":
      return {
        label,
        tone,
        detail:
          status.queuedEvents > 0
            ? `Can't reach the hub. ${pluralUpdates(status.queuedEvents)} will sync when it's back.`
            : "Can't reach the hub. Changes sync when it's back.",
      };
    case "version-mismatch":
      return {
        label,
        tone,
        detail:
          status.lastError ??
          "This app and the hub run incompatible versions. Update to reconnect.",
      };
    case "error":
      return {
        label,
        tone,
        detail: status.lastError ?? "The hub link stopped working. Unlink and link again.",
      };
    case "connecting":
      return { label, tone, detail: null };
  }
}

/** Linked to a hub account (whatever the connection state). */
export function isHubLinked(status: HubLocalStatus | null | undefined): boolean {
  return status != null && status.account !== null && status.linkId !== null;
}

/** The hub project a local project is linked to, if any. */
export function hubProjectLinkOf(
  status: HubLocalStatus | null | undefined,
  projectId: ProjectId,
): HubLocalProjectLink | null {
  return status?.projects.find((link) => link.projectId === projectId) ?? null;
}

/** The linked local project ids as one comparable string. */
export function hubLinkedProjectsKey(status: HubLocalStatus | null | undefined): string {
  if (!status || status.projects.length === 0) return "";
  return status.projects
    .map((link) => link.projectId)
    .sort()
    .join("\n");
}

export function isProjectInHubKey(key: string, projectId: ProjectId): boolean {
  return key !== "" && key.split("\n").includes(projectId);
}

export type HubUrlInputResult =
  | { readonly ok: true; readonly hubUrl: string | null }
  | { readonly ok: false; readonly error: string };

/** Validates the hub URL field: empty clears it; otherwise an http(s) origin. */
export function parseHubUrlInput(text: string): HubUrlInputResult {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: true, hubUrl: null };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter a full address, like https://hub.example.com." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "The hub address must start with https:// or http://." };
  }
  if (url.search !== "" || url.hash !== "") {
    return { ok: false, error: "Enter just the hub address, without ? or #." };
  }
  return { ok: true, hubUrl: trimmed.replace(/\/+$/u, "") };
}

/** Normalized GitHub login, or null when the text can't be one. */
export function parseGithubLoginInput(text: string): string | null {
  const login = text.trim().replace(/^@/u, "");
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(login) ? login : null;
}

/** The name to show for a hub thread's owner. */
export function hubThreadOwnerName(link: HubThreadLink): string {
  return link.ownerDisplayName || link.ownerLogin;
}

export type HubSyncIndicator = {
  readonly state: HubThreadLink["syncState"];
  readonly label: string;
};

const SYNC_LABELS: Record<HubThreadLink["syncState"], string> = {
  synced: "Synced to team hub",
  pending: "Waiting to sync",
  offline: "Hub offline, will sync later",
};

/**
 * The quiet sync marker for the viewer's own shared thread. Null for remote
 * mirrors (their owner's machine syncs them) and for threads off the hub.
 */
export function hubSyncIndicator(thread: {
  readonly hub?: HubThreadLink | undefined;
}): HubSyncIndicator | null {
  const link = thread.hub;
  if (link === undefined || isRemoteHubThread(thread)) return null;
  return { state: link.syncState, label: SYNC_LABELS[link.syncState] };
}

export interface HubInvitationGroups {
  /** Waiting for the viewer's answer, newest first. */
  readonly incoming: ReadonlyArray<HubLocalInvitation>;
  /** The viewer's pending invitations, keyed by hub project, newest first. */
  readonly outgoingByProject: ReadonlyMap<HubProjectId, ReadonlyArray<HubLocalInvitation>>;
}

const newestFirst = (left: HubLocalInvitation, right: HubLocalInvitation) =>
  right.createdAt.localeCompare(left.createdAt);

/** Splits invitations into what the viewer answers and what they can cancel. Only pending ones count. */
export function groupHubInvitations(
  invitations: ReadonlyArray<HubLocalInvitation> | null | undefined,
  /** ISO time; invitations that expired before it are dropped. */
  now: string,
): HubInvitationGroups {
  const pending = (invitations ?? [])
    .filter((invitation) => invitation.state === "pending" && invitation.expiresAt > now)
    .sort(newestFirst);
  const outgoingByProject = new Map<HubProjectId, HubLocalInvitation[]>();
  for (const invitation of pending) {
    if (invitation.direction !== "outgoing") continue;
    const list = outgoingByProject.get(invitation.hubProjectId);
    if (list) list.push(invitation);
    else outgoingByProject.set(invitation.hubProjectId, [invitation]);
  }
  return {
    incoming: pending.filter((invitation) => invitation.direction === "incoming"),
    outgoingByProject,
  };
}

/** Whether `login` already has a pending invitation in the list (GitHub logins ignore case). */
export function hasPendingHubInvitation(
  outgoing: ReadonlyArray<HubLocalInvitation>,
  login: string,
): boolean {
  const normalized = normalizeGithubLogin(login);
  return outgoing.some(
    (invitation) =>
      invitation.state === "pending" &&
      normalizeGithubLogin(invitation.inviteeLogin) === normalized,
  );
}
