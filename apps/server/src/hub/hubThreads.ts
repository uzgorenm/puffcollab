/**
 * Pure translations between local threads and hub thread streams: the
 * bootstrap a newly shared thread publishes, its summary, and how a
 * teammate's hub events become a local read-only mirror.
 *
 * @module hubThreads
 */
import {
  type GithubLogin,
  type HubAccount,
  type HubLocalInvitation,
  type HubProjectInvitation,
  type HubThreadEventBody,
  type HubThreadId,
  type HubThreadSummaryFields,
  type OrchestrationThread,
  type ProjectId,
  teamWorkCardStatusOf,
  ThreadId,
  type ThreadHubMirrorEvent,
} from "@t3tools/contracts";

/** Turns of history a thread publishes when it is first shared. */
export const HUB_BOOTSTRAP_TURN_LIMIT = 20;
/** Newest activities included in that bootstrap. */
const HUB_BOOTSTRAP_ACTIVITY_LIMIT = 200;

const MIRROR_PREFIX = "hub:";

/** The local id of a teammate's mirrored thread. Stable per hub thread. */
export const mirrorThreadIdOf = (hubThreadId: HubThreadId): ThreadId =>
  ThreadId.make(`${MIRROR_PREFIX}${hubThreadId}`);

interface TimedBody {
  readonly occurredAt: string;
  readonly body: HubThreadEventBody;
}

type SummaryInput = Parameters<typeof teamWorkCardStatusOf>[0] & {
  readonly title: string;
  readonly branch: string | null;
  readonly updatedAt: string;
};

/** What the owner publishes about a thread for lists and work cards. */
export const hubSummaryOf = (thread: SummaryInput): HubThreadSummaryFields => ({
  title: thread.title,
  branch: thread.branch,
  status: teamWorkCardStatusOf(thread),
  updatedAt: thread.updatedAt,
});

export const sameSummary = (
  left: HubThreadSummaryFields | null,
  right: HubThreadSummaryFields,
): boolean =>
  left !== null &&
  left.title === right.title &&
  left.branch === right.branch &&
  left.status === right.status &&
  cooperationKey(left.cooperation) === cooperationKey(right.cooperation) &&
  relatedKey(left.related) === relatedKey(right.related);

const cooperationKey = (cooperation: HubThreadSummaryFields["cooperation"]) =>
  cooperation === undefined
    ? ""
    : [
        cooperation.featureTopic,
        cooperation.analysisEnabled,
        cooperation.textEnabled,
        cooperation.awarenessNotify,
      ].join(" ");

const relatedKey = (related: HubThreadSummaryFields["related"]) =>
  (related ?? []).map((link) => `${link.threadId} ${link.relationship}`).join("\n");

/** The hub id of a mirror's thread, or null for a local thread id. */
export const hubThreadIdOfMirror = (threadId: ThreadId): HubThreadId | null =>
  threadId.startsWith(MIRROR_PREFIX) ? (threadId.slice(MIRROR_PREFIX.length) as HubThreadId) : null;

/**
 * The first events of a thread's hub stream, rebuilt from its current state:
 * created, summary, then recent messages, plans, activities and checkpoints in
 * time order, then its session. Not yet redacted.
 */
export const bootstrapBodies = (
  thread: OrchestrationThread,
  summary: HubThreadSummaryFields,
): ReadonlyArray<TimedBody> => {
  const threadId = thread.id;
  const timeline: Array<TimedBody> = [];
  for (const message of thread.messages) {
    if (message.streaming && message.text.length === 0) continue;
    timeline.push({
      occurredAt: message.createdAt,
      body: {
        type: "thread.message-sent",
        payload: {
          threadId,
          messageId: message.id,
          role: message.role,
          text: message.text,
          ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
          turnId: message.turnId,
          streaming: false,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        },
      },
    });
  }
  for (const proposedPlan of thread.proposedPlans) {
    timeline.push({
      occurredAt: proposedPlan.createdAt,
      body: { type: "thread.proposed-plan-upserted", payload: { threadId, proposedPlan } },
    });
  }
  for (const activity of thread.activities.slice(-HUB_BOOTSTRAP_ACTIVITY_LIMIT)) {
    timeline.push({
      occurredAt: activity.createdAt,
      body: { type: "thread.activity-appended", payload: { threadId, activity } },
    });
  }
  for (const checkpoint of thread.checkpoints) {
    timeline.push({
      occurredAt: checkpoint.completedAt,
      body: { type: "thread.turn-diff-completed", payload: { threadId, ...checkpoint } },
    });
  }
  timeline.sort((left, right) =>
    left.occurredAt < right.occurredAt ? -1 : left.occurredAt > right.occurredAt ? 1 : 0,
  );
  return [
    {
      occurredAt: thread.createdAt,
      body: {
        type: "thread.created",
        payload: {
          threadId,
          projectId: thread.projectId,
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          visibility: "shared",
        },
      },
    },
    { occurredAt: thread.updatedAt, body: { type: "thread.summary-set", payload: summary } },
    ...timeline,
    ...(thread.session !== null
      ? [
          {
            occurredAt: thread.session.updatedAt,
            body: {
              type: "thread.session-set" as const,
              payload: { threadId, session: thread.session },
            },
          },
        ]
      : []),
    ...(thread.archivedAt !== null
      ? [
          {
            occurredAt: thread.archivedAt,
            body: {
              type: "thread.archived" as const,
              payload: { threadId, archivedAt: thread.archivedAt, updatedAt: thread.archivedAt },
            },
          },
        ]
      : []),
  ];
};

/**
 * A hub event of a teammate's thread as the local mirror's orchestration
 * event, or null for hub-native events (`thread.turn-diff` is stored apart,
 * `thread.summary-set` feeds team data).
 */
export const toMirrorEvent = (
  body: HubThreadEventBody,
  mirrorThreadId: ThreadId,
  localProjectId: ProjectId,
): ThreadHubMirrorEvent | null => {
  switch (body.type) {
    case "thread.turn-diff":
    case "thread.summary-set":
      return null;
    case "thread.created":
      return {
        type: body.type,
        payload: {
          ...body.payload,
          threadId: mirrorThreadId,
          projectId: localProjectId,
          worktreePath: null,
          visibility: "shared",
        },
      };
    default:
      return {
        ...body,
        payload: { ...body.payload, threadId: mirrorThreadId },
      } as ThreadHubMirrorEvent;
  }
};

const FALLBACK_LOGIN = "ghost" as GithubLogin;

/** An account for display when the hub has not sent its details. */
export const accountOrPlaceholder = (
  accounts: ReadonlyMap<string, HubAccount>,
  accountId: string,
): HubAccount =>
  accounts.get(accountId) ??
  ({
    accountId,
    githubLogin: FALLBACK_LOGIN,
    displayName: "Teammate",
  } as HubAccount);

export const toLocalInvitation = (
  invitation: HubProjectInvitation,
  direction: HubLocalInvitation["direction"],
  accounts: ReadonlyMap<string, HubAccount>,
): HubLocalInvitation => ({
  invitationId: invitation.invitationId,
  hubProjectId: invitation.projectId,
  projectTitle: invitation.projectTitle,
  inviterLogin:
    invitation.inviterLogin ?? accountOrPlaceholder(accounts, invitation.inviterId).githubLogin,
  inviteeLogin: invitation.inviteeLogin,
  direction,
  state: invitation.state,
  createdAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
});
