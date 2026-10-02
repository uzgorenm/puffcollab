import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentOperationForbidden,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as TeamAccess from "../team/TeamAccess.ts";
import * as WorkspaceAccess from "../team/WorkspaceAccess.ts";
import * as PullRequestService from "./PullRequestService.ts";

/** The patch is often the largest PR payload and benefits from HTTP compression and flow control. */
export const pullRequestHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pullRequests",
  Effect.fnUntraced(function* (handlers) {
    const pullRequests = yield* PullRequestService.PullRequestService;
    const teamAccess = yield* TeamAccess.TeamAccess;
    const workspaceAccess = yield* WorkspaceAccess.WorkspaceAccess;
    return handlers.handle(
      "diff",
      Effect.fn("environment.pullRequests.diff")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        // Same project rule as the pull request RPCs; see WorkspaceAccess.
        const member = yield* teamAccess.resolveSessionMember(session).pipe(
          Effect.catchTags({
            TeamMemberNotFoundError: () => failEnvironmentAuthInvalid("invalid_credential"),
            TeamPersistenceError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        );
        yield* workspaceAccess.authorizeProject(member.memberId, args.payload.projectId).pipe(
          Effect.catchTags({
            WorkspaceAccessDeniedError: () =>
              failEnvironmentOperationForbidden("project_access_denied"),
            TeamPersistenceError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        );
        return yield* pullRequests.diff(args.payload);
      }),
    );
  }),
);
