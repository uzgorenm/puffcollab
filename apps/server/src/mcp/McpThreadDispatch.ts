import { type OrchestrationCommand, threadOwnerOf } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadAccess from "../team/ThreadAccess.ts";

/**
 * Dispatch for MCP tools. A tool runs on behalf of the agent inside one
 * thread, so its commands act as that thread's owner: the actor comes from the
 * thread the credential was issued for (read from the read model), never from
 * tool input, and the command passes the same `ThreadAccess` rules as a
 * client's. A command aimed at another member's thread is rejected.
 */
export const makeMcpThreadDispatch = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const threadAccess = yield* ThreadAccess.ThreadAccess;
  return (
    invocationThread: { readonly createdBy?: Parameters<typeof threadOwnerOf>[0]["createdBy"] },
    command: OrchestrationCommand,
  ) => {
    const actor = threadOwnerOf(invocationThread);
    return threadAccess
      .authorizeCommand(actor, command)
      .pipe(Effect.andThen(engine.dispatch(command, { actor })));
  };
});
