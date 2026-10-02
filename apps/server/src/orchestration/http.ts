import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TeamAccess from "../team/TeamAccess.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
    const teamAccess = yield* TeamAccess.TeamAccess;

    // The team member a request acts as; see TeamAccess.
    const resolveMember = (session: { readonly subject: string }) =>
      teamAccess.resolveSessionMember(session).pipe(
        Effect.catchTags({
          TeamMemberNotFoundError: () => failEnvironmentAuthInvalid("invalid_credential"),
          TeamPersistenceError: (error) => failEnvironmentInternal("internal_error", error),
        }),
      );
    const projectVisibilityFor = (session: { readonly subject: string }) =>
      resolveMember(session).pipe(
        Effect.flatMap((member) =>
          teamAccess
            .projectVisibility(member.memberId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause))),
        ),
      );

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const visibility = yield* projectVisibilityFor(session);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery.getCommandReadModel().pipe(
            Effect.map((readModel) => TeamAccess.filterByProjectVisibility(readModel, visibility)),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const visibility = yield* projectVisibilityFor(session);
          return yield* projectionSnapshotQuery.getShellSnapshot().pipe(
            Effect.map((snapshot) => TeamAccess.filterByProjectVisibility(snapshot, visibility)),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const member = yield* resolveMember(session);
          const canSee = yield* teamAccess
            .canSeeThread(member.memberId, args.params.threadId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
          if (!canSee) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const member = yield* resolveMember(session);
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = yield* normalizeDispatchCommand(args.payload).pipe(
            Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
          );
          // The actor comes from the authenticated session, never from the body.
          const result = yield* orchestrationEngine
            .dispatch(normalizedCommand, { actor: member.memberId })
            .pipe(
              Effect.tapError(() =>
                cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
              ),
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      );
  }),
);
