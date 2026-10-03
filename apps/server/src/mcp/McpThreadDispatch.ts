import type { OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";

/**
 * Dispatch for MCP tools. A tool runs on behalf of the agent inside one of the
 * owner's threads; its commands pass the same `ThreadAccess` rules as a
 * client's, so nothing reaches a teammate's read-only hub mirror.
 */
export const makeMcpThreadDispatch = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadAccess = yield* ThreadAccess.ThreadAccess;
  return (command: OrchestrationCommand) =>
    threadAccess.authorizeCommand(command).pipe(Effect.andThen(engine.dispatch(command)));
});
