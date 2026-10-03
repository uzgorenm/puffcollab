import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  HUB_CLOSE_CODES,
  HUB_PONG,
  HUB_PROTOCOL_RANGE,
  HubAccountId,
  HubClientFrame,
  type HubClientMessage,
  HubEnvironmentLinkId,
  type HubLinkTokenResponse,
  type HubLocalTeam,
  type HubLocalStatus,
  HubProjectId,
  type HubProjectState,
  type HubProtocolRange,
  HubServerFrame,
  type HubServerMessage,
  type HubThreadEvent,
  HubThreadId,
  type HubThreadSummary,
  MessageId,
  negotiateHubProtocol,
  type OrchestrationCommand,
  type OrchestrationEvent,
  OWNER_MEMBER_ID,
  ProjectId,
  ProviderInstanceId,
  type RepositoryIdentity,
  ThreadCommentId,
  ThreadId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as TeamAccess from "../team/TeamAccess.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";
import * as HubSync from "./HubSync.ts";
import * as HubTransport from "./HubTransport.ts";
import { mirrorThreadIdOf } from "./hubThreads.ts";

// ---------------------------------------------------------------------------
// Fake hub: an in-process HubTransport that speaks hub.ts frames.
// ---------------------------------------------------------------------------

const HUB_URL = "https://hub.test";
const LINK_ID = HubEnvironmentLinkId.make("link-me");
const ME = {
  accountId: HubAccountId.make("acct-me"),
  githubLogin: "me",
  displayName: "Me",
};
const BOB = {
  accountId: HubAccountId.make("acct-bob"),
  githubLogin: "bob",
  displayName: "Bob",
};
const HUB_PROJECT = HubProjectId.make("hub-project");
const SECRET_CREDENTIAL = "cred-very-secret-value";
const NOW = "2026-01-01T00:00:00.000Z";

const encodeServer = Schema.encodeSync(HubServerFrame);
const asText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeClient = Schema.decodeUnknownSync(HubClientFrame);

interface HubThreadState {
  projectId: HubProjectId;
  ownerId: HubAccountId;
  generation: number;
  events: Array<HubThreadEvent>;
}

const makeFakeHub = (options: { readonly range?: HubProtocolRange } = {}) =>
  Effect.gen(function* () {
    const received = yield* SubscriptionRef.make<ReadonlyArray<HubClientMessage>>([]);
    const connections = yield* SubscriptionRef.make(0);
    const threads = new Map<string, HubThreadState>();
    const tokenResponses: Array<HubLinkTokenResponse> = [];
    const pushedFrames: Array<string> = [];
    let rejectNextPublish: { readonly expectedSeq: number } | null = null;
    let briefVersion: number | null = null;
    let members = [
      { accountId: ME.accountId, role: "admin" as const, joinedAt: NOW, invitedBy: null },
      { accountId: BOB.accountId, role: "member" as const, joinedAt: NOW, invitedBy: ME.accountId },
    ];
    let socket: {
      readonly incoming: Queue.Queue<string, Cause.Done>;
      readonly closed: Deferred.Deferred<HubTransport.HubSocketClose>;
    } | null = null;

    const push = (message: HubServerMessage) =>
      Effect.suspend(() => {
        const frame = encodeServer(message);
        pushedFrames.push(frame);
        return socket === null
          ? Effect.void
          : Queue.offer(socket.incoming, frame).pipe(Effect.asVoid);
      });

    const closeSocket = (code: number) =>
      Effect.suspend(() => {
        const current = socket;
        socket = null;
        if (current === null) return Effect.void;
        return Queue.end(current.incoming).pipe(
          Effect.andThen(Deferred.succeed(current.closed, { code, reason: "closed by hub" })),
          Effect.asVoid,
        );
      });

    const summaryOf = (threadId: string, state: HubThreadState): HubThreadSummary => ({
      threadId: HubThreadId.make(threadId),
      projectId: state.projectId,
      ownerId: state.ownerId,
      generation: state.generation,
      lastSeq: state.events.at(-1)?.seq ?? 0,
      title: "Bob's thread",
      branch: null,
      status: "idle",
      updatedAt: NOW,
    });

    const projectState = (): HubProjectState => ({
      project: {
        projectId: HUB_PROJECT,
        repositoryKey: "github.com/team/app" as never,
        title: "App",
        createdBy: ME.accountId,
        createdAt: NOW,
      },
      members,
      accounts: [ME as never, BOB as never],
      brief: null,
      focuses: [],
      activity: [],
      threads: [...threads.entries()]
        .filter(([id]) => !id.startsWith(`${LINK_ID}:`))
        .map(([id, state]) => summaryOf(id, state)),
      analyses: [],
      awareness: [],
      invitations: [],
    });

    const pushEvents = (threadId: string, cursor?: { generation: number; seq: number }) =>
      Effect.gen(function* () {
        const state = threads.get(threadId);
        if (state === undefined) return;
        const sameGeneration = cursor !== undefined && cursor.generation === state.generation;
        const events = state.events.filter((event) => !sameGeneration || event.seq > cursor.seq);
        yield* push({
          type: "thread.events",
          projectId: state.projectId,
          threadId: HubThreadId.make(threadId),
          generation: state.generation,
          ...(cursor !== undefined && !sameGeneration ? { reset: true as const } : {}),
          events,
        });
      });

    const handle = (message: HubClientMessage) =>
      Effect.gen(function* () {
        yield* SubscriptionRef.update(received, (all) => [...all, message]);
        switch (message.type) {
          case "hello": {
            const range = options.range ?? HUB_PROTOCOL_RANGE;
            const version = negotiateHubProtocol(message.protocol, range);
            if (version === null) {
              yield* push({
                type: "reject",
                requestId: null,
                reason: "version-mismatch",
                message: "Versions do not overlap.",
                protocol: range,
              });
              return yield* closeSocket(HUB_CLOSE_CODES.versionMismatch);
            }
            yield* push({
              type: "welcome",
              protocolVersion: version,
              account: ME as never,
              linkId: LINK_ID,
              projects: [projectState()],
              published: [...threads.entries()]
                .filter(([id]) => id.startsWith(`${LINK_ID}:`))
                .map(([id, state]) => ({
                  threadId: HubThreadId.make(id),
                  generation: state.generation,
                  seq: state.events.at(-1)?.seq ?? 0,
                })),
              invitations: [],
              serverTime: NOW,
            });
            for (const cursor of message.subscriptions) yield* pushEvents(cursor.threadId, cursor);
            return;
          }
          case "thread.subscribe":
            return yield* pushEvents(message.threadId, message.cursor);
          case "publish": {
            const reject = rejectNextPublish;
            if (reject !== null) {
              rejectNextPublish = null;
              return yield* push({
                type: "reject",
                requestId: message.requestId,
                reason: "conflict",
                message: "Gap.",
                expectedSeq: reject.expectedSeq,
              });
            }
            let state = threads.get(message.threadId);
            if (state === undefined || message.reset === true) {
              state = {
                projectId: message.projectId,
                ownerId: ME.accountId,
                generation: (state?.generation ?? 0) + 1,
                events: [],
              };
              threads.set(message.threadId, state);
            }
            for (const event of message.events) {
              const last = state.events.at(-1)?.seq ?? 0;
              if (event.seq <= last) continue;
              if (event.seq !== last + 1) {
                return yield* push({
                  type: "reject",
                  requestId: message.requestId,
                  reason: "conflict",
                  message: "Gap.",
                  expectedSeq: last + 1,
                });
              }
              state.events.push(event);
            }
            return yield* push({
              type: "ack",
              requestId: message.requestId,
              cursor: {
                threadId: message.threadId,
                generation: state.generation,
                seq: state.events.at(-1)?.seq ?? 0,
              },
            });
          }
          case "comment.add":
            yield* push({ type: "ack", requestId: message.requestId });
            return yield* push({
              type: "comment.added",
              projectId: HUB_PROJECT,
              comment: {
                commentId: message.commentId,
                threadId: message.threadId,
                authorId: ME.accountId,
                text: message.text,
                createdAt: NOW,
              },
            });
          case "brief.update": {
            if (message.expectedVersion !== briefVersion) {
              return yield* push({
                type: "reject",
                requestId: message.requestId,
                reason: "conflict",
                message: "The brief changed.",
                currentVersion: briefVersion,
              });
            }
            briefVersion = (briefVersion ?? 0) + 1;
            yield* push({ type: "ack", requestId: message.requestId });
            return yield* push({
              type: "team.brief",
              brief: {
                projectId: message.projectId,
                version: briefVersion,
                text: message.text,
                authorId: ME.accountId,
                createdAt: NOW,
              },
            });
          }
          case "focus.set":
            yield* push({ type: "ack", requestId: message.requestId });
            return yield* push({
              type: "team.focus",
              projectId: message.projectId,
              accountId: ME.accountId,
              focus:
                message.focus === null
                  ? null
                  : {
                      projectId: message.projectId,
                      accountId: ME.accountId,
                      focus: message.focus,
                      updatedAt: NOW,
                    },
            });
          case "member.remove":
            members = members.filter((member) => member.accountId !== message.accountId);
            yield* push({ type: "ack", requestId: message.requestId });
            return yield* push({
              type: "team.members",
              projectId: message.projectId,
              members,
              accounts: [ME as never, BOB as never],
            });
          case "member.leave":
            yield* push({ type: "ack", requestId: message.requestId });
            return yield* push({
              type: "team.removed",
              projectId: message.projectId,
              reason: "left",
            });
          default:
            return;
        }
      });

    const request: HubTransport.HubTransport["Service"]["request"] = (input) =>
      Effect.sync(() => {
        const path = input.url.slice(HUB_URL.length);
        if (path === "/v1/link/requests") {
          return {
            status: 201,
            body: {
              requestId: "req-1",
              userCode: "ABCD-EFGH",
              verificationUrl: `${HUB_URL}/link?code=ABCD-EFGH`,
              expiresAt: "2026-01-01T00:10:00.000Z",
              intervalSeconds: 5,
            },
          };
        }
        if (path === "/v1/link/token") {
          return { status: 200, body: tokenResponses.shift() ?? { status: "pending" } };
        }
        if (path === "/v1/projects/link") {
          return {
            status: 200,
            body: {
              project: projectState().project,
              created: true,
              alternatives: [
                { ...projectState().project, projectId: "other-team-project", title: "Other" },
              ],
            },
          };
        }
        if (path === "/v1/environment" && input.method === "DELETE") {
          return { status: 204, body: null };
        }
        return { status: 404, body: null };
      });

    const connect: HubTransport.HubTransport["Service"]["connect"] = (input) =>
      Effect.gen(function* () {
        expect(input.bearer).toBe(SECRET_CREDENTIAL);
        expect(input.url).toBe("wss://hub.test/v1/sync");
        const incoming = yield* Queue.unbounded<string, Cause.Done>();
        const closed = yield* Deferred.make<HubTransport.HubSocketClose>();
        socket = { incoming, closed };
        yield* SubscriptionRef.update(connections, (count) => count + 1);
        const mine = socket;
        return {
          send: (frame) =>
            frame === "ping"
              ? Queue.offer(incoming, HUB_PONG).pipe(Effect.asVoid)
              : socket === mine
                ? handle(decodeClient(frame))
                : Effect.void,
          incoming: Stream.fromQueue(incoming),
          closed: Deferred.await(closed),
          close: (code = 1000) => (socket === mine ? closeSocket(code) : Effect.void),
        } satisfies HubTransport.HubSocket;
      });

    const waitFor = <A extends HubClientMessage>(
      predicate: (message: HubClientMessage) => message is A,
    ) =>
      SubscriptionRef.changes(received).pipe(
        Stream.map((all) => all.find(predicate)),
        Stream.filter((found) => found !== undefined),
        Stream.runHead,
        Effect.map((found) => Option.getOrThrow(found) as A),
      );

    return {
      layer: Layer.succeed(
        HubTransport.HubTransport,
        HubTransport.HubTransport.of({ request, connect }),
      ),
      received,
      connections,
      threads,
      pushedFrames,
      push,
      closeSocket,
      waitFor,
      rejectNextPublishWith: (expectedSeq: number) => {
        rejectNextPublish = { expectedSeq };
      },
      queueToken: (response: HubLinkTokenResponse) => tokenResponses.push(response),
      publishedThreadIds: Effect.map(SubscriptionRef.get(received), (all) =>
        all.flatMap((message) => (message.type === "publish" ? [message.threadId] : [])),
      ),
    };
  });

type FakeHub = Effect.Success<ReturnType<typeof makeFakeHub>>;

// ---------------------------------------------------------------------------
// Server under test
// ---------------------------------------------------------------------------

const identity: RepositoryIdentity = {
  canonicalKey: "github.com/team/app",
  locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@github.com:team/app.git" },
};

const engineLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(
    Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
      resolve: () => Effect.succeed(identity),
    }),
  ),
);

const PATCH = "diff --git a/app.ts b/app.ts\n+const key = 'sk-abcdefghijklmnopqrstuv';\n";

const baseLayer = Layer.mergeAll(
  engineLayer,
  ThreadAccess.layer,
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
    getTurnDiff: (input) =>
      Effect.succeed({
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff: PATCH,
      }),
  }),
).pipe(
  Layer.provideMerge(TeamAccess.layer),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hub-sync-test-" })),
);

/** Runs `body` against a started HubSync; closing it is a server shutdown. */
const withHub = <A, E, R>(
  fake: FakeHub,
  body: (hub: HubSync.HubSync["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(HubSync.layer.pipe(Layer.provide(fake.layer)));
      const hub = Context.get(context, HubSync.HubSync);
      yield* hub.start();
      return yield* body(hub);
    }),
  );

const waitStatus = (
  hub: HubSync.HubSync["Service"],
  predicate: (status: HubLocalStatus) => boolean,
) =>
  hub.subscribeStatus.pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

/** Forks a wait for the next committed event matching `predicate`; join it after acting. */
const waitForEvent = (predicate: (event: OrchestrationEvent) => boolean) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const events = yield* engine.subscribeDomainEvents;
    return yield* events.pipe(Stream.filter(predicate), Stream.runHead, Effect.forkScoped);
  });

let commandCounter = 0;
const nextCommandId = () => CommandId.make(`cmd-${(commandCounter += 1)}`);
const dispatch = (command: OrchestrationCommand) =>
  OrchestrationEngineService.pipe(
    Effect.flatMap((engine) => engine.dispatch(command, { actor: OWNER_MEMBER_ID })),
  );

const PROJECT = ProjectId.make("project-linked");
const OTHER_PROJECT = ProjectId.make("project-unlinked");
const WORKSPACE = "/work/team-app";

const createProject = (projectId: ProjectId, workspaceRoot: string) =>
  dispatch({
    type: "project.create",
    commandId: nextCommandId(),
    projectId,
    title: "Team app",
    workspaceRoot,
    createdAt: NOW,
  });

const createThread = (threadId: ThreadId, projectId: ProjectId, visibility: "shared" | "private") =>
  dispatch({
    type: "thread.create",
    commandId: nextCommandId(),
    threadId,
    projectId,
    title: `Thread ${threadId}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    visibility,
    createdAt: NOW,
  });

const appendUserMessage = (threadId: ThreadId, text: string) =>
  dispatch({
    type: "thread.message.user.append",
    commandId: nextCommandId(),
    threadId,
    message: { messageId: MessageId.make(`msg-${commandCounter}`), text, attachments: [] },
    createdAt: NOW,
  });

/** Links the environment through the fake hub's link-code flow. */
const linkEnvironment = (hub: HubSync.HubSync["Service"], fake: FakeHub) =>
  Effect.gen(function* () {
    yield* hub.configure({ hubUrl: `${HUB_URL}/` });
    fake.queueToken({
      status: "linked",
      linkId: LINK_ID,
      credential: SECRET_CREDENTIAL,
      account: ME as never,
    });
    yield* hub.linkStart();
    yield* TestClock.adjust("5 seconds");
    yield* waitStatus(hub, (status) => status.state === "online");
  });

/** Shared and private threads in a linked project, and one in an unlinked project. */
const setupProjects = (hub: HubSync.HubSync["Service"]) =>
  Effect.gen(function* () {
    yield* createProject(PROJECT, WORKSPACE);
    yield* createProject(OTHER_PROJECT, "/work/other");
    yield* hub.linkProject({ projectId: PROJECT });
  });

const sharedEvents = (fake: FakeHub, threadId: ThreadId) =>
  fake.threads.get(`${LINK_ID}:${threadId}`)?.events ?? [];

const REMOTE_HUB_THREAD = HubThreadId.make("link-bob:t-remote");

const seedTeammateThread = (fake: FakeHub) => {
  fake.threads.set(REMOTE_HUB_THREAD, {
    projectId: HUB_PROJECT,
    ownerId: BOB.accountId,
    generation: 1,
    events: [
      {
        seq: 1,
        occurredAt: NOW,
        body: {
          type: "thread.created",
          payload: {
            threadId: ThreadId.make("t-remote"),
            projectId: ProjectId.make("bobs-project"),
            title: "Bob's thread",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: NOW,
            updatedAt: NOW,
            visibility: "shared",
          },
        },
      },
      {
        seq: 2,
        occurredAt: NOW,
        body: {
          type: "thread.message-sent",
          payload: {
            threadId: ThreadId.make("t-remote"),
            messageId: MessageId.make("bob-msg-1"),
            role: "user",
            text: "Refactor the parser",
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      },
    ],
  });
};

const isAckFor =
  (threadId: string, seq: number) =>
  (message: HubClientMessage): message is Extract<HubClientMessage, { type: "ack" }> =>
    message.type === "ack" &&
    message.cursors.some((cursor) => cursor.threadId === threadId && cursor.seq >= seq);

it.layer(NodeServices.layer)("HubSync", (it) => {
  it.effect("links with a PKCE link code and keeps the credential in the secret store", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          const notConfigured = yield* Effect.flip(hub.linkStart());
          expect(notConfigured.reason).toBe("not-configured");

          yield* hub.configure({ hubUrl: `${HUB_URL}/` });
          // First poll: still pending; second: linked.
          fake.queueToken({ status: "pending" });
          fake.queueToken({
            status: "linked",
            linkId: LINK_ID,
            credential: SECRET_CREDENTIAL,
            account: ME as never,
          });
          const pending = yield* hub.linkStart();
          expect(pending.userCode).toBe("ABCD-EFGH");
          const linking = yield* hub.status;
          expect(linking).toMatchObject({
            state: "linking",
            hubUrl: HUB_URL,
            pendingLink: pending,
          });

          yield* TestClock.adjust("5 seconds");
          expect((yield* hub.status).state).toBe("linking");
          yield* TestClock.adjust("5 seconds");
          const online = yield* waitStatus(hub, (status) => status.state === "online");
          expect(online).toMatchObject({ linkId: LINK_ID, account: ME, pendingLink: null });

          const secrets = yield* ServerSecretStore.ServerSecretStore;
          const stored = yield* secrets.get(HubSync.HUB_CREDENTIAL_SECRET);
          expect(new TextDecoder().decode(Option.getOrThrow(stored))).toBe(SECRET_CREDENTIAL);
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ row: string }>`SELECT json_object(
            'url', hub_url, 'link', link_id, 'account', account_json) AS row FROM hub_link`;
          expect(rows[0]?.row).not.toContain(SECRET_CREDENTIAL);

          const unlinked = yield* hub.unlink();
          expect(unlinked).toMatchObject({ state: "unlinked", linkId: null, account: null });
          expect(Option.isNone(yield* secrets.get(HubSync.HUB_CREDENTIAL_SECRET))).toBe(true);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("a denied link returns to unlinked with the reason", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* hub.configure({ hubUrl: HUB_URL });
          fake.queueToken({ status: "denied" });
          yield* hub.linkStart();
          yield* TestClock.adjust("5 seconds");
          const status = yield* waitStatus(hub, (next) => next.pendingLink === null);
          expect(status).toMatchObject({
            state: "unlinked",
            lastError: expect.stringMatching(/denied/),
          });
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "publishes only shared threads of linked projects, redacted, with contiguous seqs",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakeHub();
        yield* withHub(fake, (hub) =>
          Effect.gen(function* () {
            yield* linkEnvironment(hub, fake);
            yield* setupProjects(hub);
            const shared = ThreadId.make("t-shared");
            const secret = ThreadId.make("t-private");
            const elsewhere = ThreadId.make("t-unlinked-project");
            yield* createThread(shared, PROJECT, "shared");
            yield* createThread(secret, PROJECT, "private");
            yield* createThread(elsewhere, OTHER_PROJECT, "shared");
            yield* appendUserMessage(
              shared,
              `See ${WORKSPACE}/src/app.ts; key sk-abcdefghijklmnopqrstuv`,
            );
            yield* appendUserMessage(secret, "private notes");
            yield* appendUserMessage(elsewhere, "other project notes");
            yield* dispatch({
              type: "thread.turn.diff.complete",
              commandId: nextCommandId(),
              threadId: shared,
              turnId: "turn-1" as never,
              checkpointTurnCount: 1,
              checkpointRef: "refs/t3/checkpoints/1" as never,
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: NOW,
              createdAt: NOW,
            } as never);
            yield* hub.drain;
            yield* waitStatus(hub, (status) => status.queuedEvents === 0);

            const published = new Set(yield* fake.publishedThreadIds);
            expect([...published]).toEqual([`${LINK_ID}:${shared}`]);
            const events = sharedEvents(fake, shared);
            expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
            expect(events.slice(0, 2).map((event) => event.body.type)).toEqual([
              "thread.created",
              "thread.summary-set",
            ]);
            const message = events.find((event) => event.body.type === "thread.message-sent");
            const text =
              message?.body.type === "thread.message-sent" ? message.body.payload.text : "";
            expect(text).toContain("./src/app.ts");
            expect(text).not.toContain(WORKSPACE);
            expect(text).not.toContain("sk-abcdefghijklmnopqrstuv");
            const diff = events.find((event) => event.body.type === "thread.turn-diff");
            expect(diff?.body.type === "thread.turn-diff" && diff.body.payload.diff).toContain(
              "[redacted]",
            );
            const everything = asText(yield* SubscriptionRef.get(fake.received));
            expect(everything).not.toContain("private notes");
            expect(everything).not.toContain("other project notes");

            // The owner's own shared thread carries its sync state.
            const snapshots = yield* ProjectionSnapshotQuery;
            const shell = Option.getOrThrow(yield* snapshots.getThreadShellById(shared));
            expect(shell.hub).toMatchObject({ remote: false, ownerId: ME.accountId });

            // Making it private publishes the removal and stops.
            yield* dispatch({
              type: "thread.visibility.set",
              commandId: nextCommandId(),
              threadId: shared,
              visibility: "private",
            });
            yield* appendUserMessage(shared, "after going private");
            yield* hub.drain;
            yield* waitStatus(hub, (status) => status.queuedEvents === 0);
            const after = sharedEvents(fake, shared);
            expect(after.at(-1)?.body).toMatchObject({
              type: "thread.visibility-set",
              payload: { visibility: "private" },
            });
            expect(asText(after)).not.toContain("after going private");
          }),
        );
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("queues offline and resumes after a restart from the hub's acked cursors", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      const shared = ThreadId.make("t-resume");
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          yield* createThread(shared, PROJECT, "shared");
          yield* hub.drain;
          yield* waitStatus(hub, (status) => status.queuedEvents === 0);
          // The hub goes away; new events queue durably.
          yield* fake.closeSocket(1006);
          yield* waitStatus(hub, (status) => status.state === "offline");
          yield* appendUserMessage(shared, "written while offline");
          yield* hub.drain;
          yield* waitStatus(hub, (status) => status.queuedEvents > 0);
        }),
      );
      const before = sharedEvents(fake, shared).length;
      // Restart: a fresh HubSync on the same database reconnects and sends
      // only what the hub has not acknowledged.
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* waitStatus(hub, (status) => status.state === "online");
          yield* waitStatus(hub, (status) => status.queuedEvents === 0);
          const events = sharedEvents(fake, shared);
          expect(events.length).toBeGreaterThan(before);
          expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
          expect(asText(events.slice(before))).toContain("written while offline");
          const publishes = (yield* SubscriptionRef.get(fake.received)).filter(
            (message) => message.type === "publish",
          );
          const last = publishes.at(-1);
          expect(last?.type === "publish" && last.events[0]?.seq).toBe(before + 1);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("re-sends from the hub's expected seq after a conflict", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          const shared = ThreadId.make("t-conflict");
          yield* createThread(shared, PROJECT, "shared");
          yield* hub.drain;
          yield* waitStatus(hub, (status) => status.queuedEvents === 0);
          const accepted = sharedEvents(fake, shared).length;
          // The hub answers the next batch with a gap: it expects seq 1 again
          // after losing data, which this server can only satisfy by restarting.
          fake.rejectNextPublishWith(accepted + 1);
          yield* appendUserMessage(shared, "first after conflict");
          yield* hub.drain;
          yield* waitStatus(hub, (status) => status.queuedEvents === 0);
          const events = sharedEvents(fake, shared);
          expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
          expect(asText(events)).toContain("first after conflict");
          const attempts = (yield* SubscriptionRef.get(fake.received)).filter(
            (message) =>
              message.type === "publish" && asText(message).includes("first after conflict"),
          );
          // Refused once, then re-sent from the seq the hub expected.
          expect(attempts).toHaveLength(2);
          expect(
            attempts.map((message) => message.type === "publish" && message.events[0]?.seq),
          ).toEqual([accepted + 1, accepted + 1]);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("mirrors a teammate's thread read-only and removes it on thread.removed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      seedTeammateThread(fake);
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          yield* fake.waitFor(isAckFor(REMOTE_HUB_THREAD, 2));

          const mirrorId = mirrorThreadIdOf(REMOTE_HUB_THREAD);
          const snapshots = yield* ProjectionSnapshotQuery;
          const shell = yield* snapshots.getShellSnapshot();
          const mirror = shell.threads.find((thread) => thread.id === mirrorId);
          expect(mirror).toMatchObject({
            projectId: PROJECT,
            hub: {
              remote: true,
              ownerId: BOB.accountId,
              ownerLogin: "bob",
              ownerDisplayName: "Bob",
              threadId: REMOTE_HUB_THREAD,
            },
          });
          const detail = Option.getOrThrow(yield* snapshots.getThreadDetailById(mirrorId));
          expect(detail.messages.map((message) => message.text)).toEqual(["Refactor the parser"]);

          // Nothing local controls it, not even the environment owner.
          const access = yield* ThreadAccess.ThreadAccess;
          const denied = yield* Effect.flip(
            access.authorizeCommand(OWNER_MEMBER_ID, {
              type: "thread.turn.start",
              commandId: nextCommandId(),
              threadId: mirrorId,
              message: {
                messageId: MessageId.make("m-x"),
                role: "user",
                text: "hi",
                attachments: [],
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: NOW,
            } as never),
          );
          expect(denied).toMatchObject({ reason: "remote-hub-thread" });
          for (const type of ["thread.archive", "thread.delete", "thread.session.stop"] as const) {
            const refused = yield* Effect.flip(
              access.authorizeCommand(OWNER_MEMBER_ID, {
                type,
                commandId: nextCommandId(),
                threadId: mirrorId,
                createdAt: NOW,
              } as never),
            );
            expect(refused).toMatchObject({ reason: "remote-hub-thread" });
          }
          yield* access.authorizeCommand(OWNER_MEMBER_ID, {
            type: "thread.comment.add",
            commandId: nextCommandId(),
            threadId: mirrorId,
            commentId: ThreadCommentId.make("c-allowed"),
            text: "Looks good",
            createdAt: NOW,
          });

          // A later event appends to the mirror.
          const state = fake.threads.get(REMOTE_HUB_THREAD)!;
          state.events.push({
            seq: 3,
            occurredAt: NOW,
            body: {
              type: "thread.message-sent",
              payload: {
                threadId: ThreadId.make("t-remote"),
                messageId: MessageId.make("bob-msg-2"),
                role: "assistant",
                text: "Done",
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            },
          });
          yield* fake.push({
            type: "thread.events",
            projectId: HUB_PROJECT,
            threadId: REMOTE_HUB_THREAD,
            generation: 1,
            events: [state.events[2]!],
          });
          yield* fake.waitFor(isAckFor(REMOTE_HUB_THREAD, 3));
          const updated = Option.getOrThrow(yield* snapshots.getThreadDetailById(mirrorId));
          expect(updated.messages.map((message) => message.text)).toEqual([
            "Refactor the parser",
            "Done",
          ]);

          const removed = yield* waitForEvent(
            (event) => event.type === "thread.deleted" && event.aggregateId === mirrorId,
          );
          yield* fake.push({
            type: "thread.removed",
            projectId: HUB_PROJECT,
            threadId: REMOTE_HUB_THREAD,
            reason: "private",
          });
          yield* Fiber.join(removed);
          const remaining = yield* snapshots.getShellSnapshot();
          expect(remaining.threads.some((thread) => thread.id === mirrorId)).toBe(false);
          // The mirror never published anything back.
          expect(yield* fake.publishedThreadIds).not.toContain(REMOTE_HUB_THREAD);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("resubscribes from its cursor when a teammate's stream arrives with a gap", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      seedTeammateThread(fake);
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          yield* fake.waitFor(isAckFor(REMOTE_HUB_THREAD, 2));
          yield* fake.push({
            type: "thread.events",
            projectId: HUB_PROJECT,
            threadId: REMOTE_HUB_THREAD,
            generation: 1,
            events: [{ ...fake.threads.get(REMOTE_HUB_THREAD)!.events[1]!, seq: 4 }],
          });
          const resubscribed = yield* fake.waitFor(
            (message): message is Extract<HubClientMessage, { type: "thread.subscribe" }> =>
              message.type === "thread.subscribe" && message.cursor !== undefined,
          );
          expect(resubscribed.cursor).toEqual({
            threadId: REMOTE_HUB_THREAD,
            generation: 1,
            seq: 2,
          });
          expect(
            (yield* SubscriptionRef.get(fake.received)).some(isAckFor(REMOTE_HUB_THREAD, 4)),
          ).toBe(false);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("routes comments through the hub and never into thread messages", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      seedTeammateThread(fake);
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          yield* fake.waitFor(isAckFor(REMOTE_HUB_THREAD, 2));
          const mirrorId = mirrorThreadIdOf(REMOTE_HUB_THREAD);

          // A teammate's comment arrives from the hub.
          const projected = yield* waitForEvent(
            (event) => event.type === "thread.comment-added" && event.payload.commentId === "c-bob",
          );
          yield* fake.push({
            type: "comment.added",
            projectId: HUB_PROJECT,
            comment: {
              commentId: ThreadCommentId.make("c-bob"),
              threadId: REMOTE_HUB_THREAD,
              authorId: BOB.accountId,
              text: "Check the edge case",
              createdAt: NOW,
            },
          });
          yield* Fiber.join(projected);
          // A local comment on the mirror goes to the hub.
          yield* dispatch({
            type: "thread.comment.add",
            commandId: nextCommandId(),
            threadId: mirrorId,
            commentId: ThreadCommentId.make("c-me"),
            text: "Will do",
            createdAt: NOW,
          });
          const sent = yield* fake.waitFor(
            (message): message is Extract<HubClientMessage, { type: "comment.add" }> =>
              message.type === "comment.add",
          );
          expect(sent).toMatchObject({
            threadId: REMOTE_HUB_THREAD,
            commentId: "c-me",
            text: "Will do",
          });

          const snapshots = yield* ProjectionSnapshotQuery;
          const detail = Option.getOrThrow(
            yield* snapshots.getThreadDetailSnapshot(mirrorId),
          ).thread;
          const comments = detail.comments ?? [];
          expect(comments.find((comment) => comment.id === "c-bob")).toMatchObject({
            authorId: "hub:acct-bob",
            hubAuthor: { githubLogin: "bob" },
          });
          expect(comments.find((comment) => comment.id === "c-me")?.hubAuthor).toBeUndefined();
          expect(detail.messages.map((message) => message.text)).toEqual(["Refactor the parser"]);
          // Hub comments are not echoed back to the hub.
          const adds = (yield* SubscriptionRef.get(fake.received)).filter(
            (message) => message.type === "comment.add",
          );
          expect(adds).toHaveLength(1);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("shows a linked project's hub members, removes one, and leaving unlinks it", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          const unlinked = yield* hub.subscribeProjectTeam(OTHER_PROJECT).pipe(Stream.runHead);
          expect(Option.getOrThrow(unlinked).team).toBeNull();
          const teamOf = (predicate: (count: number) => boolean) =>
            hub.subscribeProjectTeam(PROJECT).pipe(
              Stream.filter(
                (result) => result.team !== null && predicate(result.team.members.length),
              ),
              Stream.runHead,
              Effect.map((result) => Option.getOrThrow(result).team!),
            );
          const team = yield* teamOf((count) => count === 2);
          expect(team).toMatchObject({
            projectId: PROJECT,
            hubProjectId: HUB_PROJECT,
            viewerAccountId: ME.accountId,
            creatorId: ME.accountId,
          });
          expect(team.members.map((member) => [member.githubLogin, member.role])).toEqual([
            ["me", "admin"],
            ["bob", "member"],
          ]);

          yield* hub.removeMember({ projectId: PROJECT, accountId: BOB.accountId });
          const after = yield* teamOf((count) => count === 1);
          expect(after.members.map((member) => member.githubLogin)).toEqual(["me"]);

          yield* hub.leaveProject({ projectId: PROJECT });
          const status = yield* waitStatus(hub, (next) => next.projects.length === 0);
          expect(status.projects).toEqual([]);
          const gone = yield* hub.subscribeProjectTeam(PROJECT).pipe(Stream.runHead);
          expect(Option.getOrThrow(gone).team).toBeNull();
          const notLinked = yield* Effect.flip(
            hub.removeMember({ projectId: PROJECT, accountId: BOB.accountId }),
          );
          expect(notLinked.reason).toBe("invalid");
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("serves Team overview from the hub with local thread ids", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      seedTeammateThread(fake);
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          const own = ThreadId.make("t-own");
          const ownHubId = HubThreadId.make(`${LINK_ID}:${own}`);
          yield* fake.push({
            type: "team.thread",
            summary: {
              threadId: ownHubId,
              projectId: HUB_PROJECT,
              ownerId: ME.accountId,
              generation: 1,
              lastSeq: 2,
              title: "My thread",
              branch: "feature/x",
              status: "working",
              updatedAt: NOW,
            },
          });
          yield* fake.push({
            type: "team.analysis",
            projectId: HUB_PROJECT,
            summaries: [{ threadId: REMOTE_HUB_THREAD, summary: "Bob refactors.", updatedAt: NOW }],
          });
          yield* fake.push({
            type: "team.activity",
            projectId: HUB_PROJECT,
            items: [
              {
                id: "act-1",
                projectId: HUB_PROJECT,
                kind: "thread-created",
                threadId: REMOTE_HUB_THREAD,
                actorId: BOB.accountId,
                detail: "Bob's thread",
                occurredAt: NOW,
                sequence: 1,
              },
            ],
          });
          const teamWhere = (predicate: (team: HubLocalTeam) => boolean) =>
            hub.subscribeProjectTeam(PROJECT).pipe(
              Stream.filter((result) => result.team !== null && predicate(result.team)),
              Stream.runHead,
              Effect.map((result) => Option.getOrThrow(result).team!),
            );
          const team = yield* teamWhere(
            (next) =>
              next.workCards.length === 2 &&
              next.activity.length === 1 &&
              next.workCards.some((card) => card.analysis !== null),
          );
          expect(team.workCards).toEqual([
            {
              threadId: own,
              hubThreadId: ownHubId,
              ownerId: ME.accountId,
              title: "My thread",
              status: "working",
              lastActivityAt: NOW,
              branch: "feature/x",
              analysis: null,
            },
            expect.objectContaining({
              threadId: mirrorThreadIdOf(REMOTE_HUB_THREAD),
              ownerId: BOB.accountId,
              analysis: { summary: "Bob refactors.", updatedAt: NOW },
            }),
          ]);
          expect(team.activity[0]).toMatchObject({
            threadId: mirrorThreadIdOf(REMOTE_HUB_THREAD),
            actorId: BOB.accountId,
          });

          yield* hub.updateBrief({
            projectId: PROJECT,
            text: "Ship refunds",
            expectedVersion: null,
          });
          const withBrief = yield* teamWhere((next) => next.brief !== null);
          expect(withBrief.brief).toMatchObject({ version: 1, text: "Ship refunds" });
          const conflict = yield* Effect.flip(
            hub.updateBrief({ projectId: PROJECT, text: "Overwrite", expectedVersion: null }),
          );
          expect(conflict.reason).toBe("conflict");

          yield* hub.setFocus({ projectId: PROJECT, focus: "Refund API" });
          const focused = yield* teamWhere((next) => next.focuses.length === 1);
          expect(focused.focuses[0]).toMatchObject({
            accountId: ME.accountId,
            focus: "Refund API",
          });
          yield* hub.setFocus({ projectId: PROJECT, focus: null });
          yield* teamWhere((next) => next.focuses.length === 0);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("syncs related-thread links both ways through thread summaries", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      seedTeammateThread(fake);
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* linkEnvironment(hub, fake);
          yield* setupProjects(hub);
          yield* fake.waitFor(isAckFor(REMOTE_HUB_THREAD, 2));
          const mirrorId = mirrorThreadIdOf(REMOTE_HUB_THREAD);
          const own = ThreadId.make("t-own");
          const secret = ThreadId.make("t-secret");
          yield* createThread(own, PROJECT, "shared");
          yield* createThread(secret, PROJECT, "private");
          for (const [relatedThreadId, relationship] of [
            [mirrorId, "complementary"],
            [secret, "alternative"],
          ] as const) {
            yield* dispatch({
              type: "thread.related-thread.link",
              commandId: nextCommandId(),
              threadId: own,
              relatedThreadId,
              relationship,
            });
          }
          yield* hub.drain;
          yield* waitStatus(hub, (status) => status.queuedEvents === 0);
          const summaries = sharedEvents(fake, own).flatMap((event) =>
            event.body.type === "thread.summary-set" ? [event.body.payload] : [],
          );
          // The private thread's link stays on this computer.
          expect(summaries.at(-1)?.related).toEqual([
            { threadId: REMOTE_HUB_THREAD, relationship: "complementary" },
          ]);

          // Bob linked his thread to ours: the mirror shows it.
          const linked = yield* waitForEvent(
            (event) =>
              event.type === "thread.related-thread-linked" && event.aggregateId === mirrorId,
          );
          yield* fake.push({
            type: "team.thread",
            summary: {
              threadId: REMOTE_HUB_THREAD,
              projectId: HUB_PROJECT,
              ownerId: BOB.accountId,
              generation: 1,
              lastSeq: 2,
              title: "Bob's thread",
              branch: null,
              status: "idle",
              updatedAt: NOW,
              related: [
                { threadId: HubThreadId.make(`${LINK_ID}:${own}`), relationship: "alternative" },
              ],
            },
          });
          yield* Fiber.join(linked);
          const snapshots = yield* ProjectionSnapshotQuery;
          const mirror = Option.getOrThrow(yield* snapshots.getThreadDetailById(mirrorId));
          expect(mirror.relatedThreads).toEqual([
            expect.objectContaining({ relatedThreadId: own, relationship: "alternative" }),
          ]);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("stops reconnecting on a protocol version mismatch", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub({ range: { min: 99, max: 99 } });
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          yield* hub.configure({ hubUrl: HUB_URL });
          fake.queueToken({
            status: "linked",
            linkId: LINK_ID,
            credential: SECRET_CREDENTIAL,
            account: ME as never,
          });
          yield* hub.linkStart();
          yield* TestClock.adjust("5 seconds");
          const status = yield* waitStatus(hub, (next) => next.state === "version-mismatch");
          expect(status.lastError).toMatch(/Update Puff Collab/);
          yield* TestClock.adjust("10 minutes");
          expect(yield* SubscriptionRef.get(fake.connections)).toBe(1);
          expect((yield* hub.status).state).toBe("version-mismatch");
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );

  it.effect("reports status transitions and reconnects with backoff", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeHub();
      yield* withHub(fake, (hub) =>
        Effect.gen(function* () {
          const states: Array<HubLocalStatus["state"]> = [];
          yield* hub.subscribeStatus.pipe(
            Stream.runForEach((status) =>
              Effect.sync(() => {
                if (states.at(-1) !== status.state) states.push(status.state);
              }),
            ),
            Effect.forkScoped({ startImmediately: true }),
          );
          yield* linkEnvironment(hub, fake);
          yield* fake.closeSocket(1006);
          yield* waitStatus(hub, (status) => status.state === "offline");
          yield* TestClock.adjust("1 second");
          yield* waitStatus(hub, (status) => status.state === "online");
          expect(yield* SubscriptionRef.get(fake.connections)).toBe(2);
          yield* fake.closeSocket(HUB_CLOSE_CODES.linkRevoked);
          const revoked = yield* waitStatus(hub, (status) => status.state === "error");
          expect(revoked.lastError).toMatch(/Link it again/);
          yield* TestClock.adjust("10 minutes");
          expect(yield* SubscriptionRef.get(fake.connections)).toBe(2);
          expect(states).toEqual([
            "unlinked",
            "linking",
            "connecting",
            "online",
            "offline",
            "connecting",
            "online",
            "error",
          ]);
        }),
      );
    }).pipe(Effect.provide(baseLayer)),
  );
});
