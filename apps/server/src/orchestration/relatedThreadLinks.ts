/**
 * Related-thread links (Puff Collab): the owner of a thread records that it
 * complements, or is an alternative to, another thread in the same project.
 * Only the owner may link or unlink; ThreadAccess.authorizeCommand enforces
 * that before dispatch, so the decider only validates the link itself.
 *
 * The decider half is pure and runs inside `decideOrchestrationCommand`; the
 * projector half keeps `OrchestrationThread.relatedThreads` current in the
 * command read model. Links are display metadata for people. Nothing here
 * feeds provider input.
 *
 * @module relatedThreadLinks
 */
import {
  isThreadShared,
  type OrchestrationReadModel,
  threadOwnerOf,
  type ThreadRelatedThreadLinkCommand,
  type ThreadRelatedThreadLinkedPayload,
  type ThreadRelatedThreadUnlinkCommand,
  type ThreadRelatedThreadUnlinkedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

type RelatedThreadCommand =
  | typeof ThreadRelatedThreadLinkCommand.Type
  | typeof ThreadRelatedThreadUnlinkCommand.Type;

export type PlannedRelatedThreadEvent =
  | {
      readonly type: "thread.related-thread-linked";
      readonly payload: ThreadRelatedThreadLinkedPayload;
    }
  | {
      readonly type: "thread.related-thread-unlinked";
      readonly payload: ThreadRelatedThreadUnlinkedPayload;
    };

const reject = (command: RelatedThreadCommand, detail: string) =>
  new OrchestrationCommandInvariantError({ commandType: command.type, detail });

/** Decide a link/unlink command for a thread its owner controls. */
export const decideRelatedThreadCommand = (input: {
  readonly command: RelatedThreadCommand;
  readonly readModel: OrchestrationReadModel;
  readonly occurredAt: string;
}): Effect.Effect<PlannedRelatedThreadEvent, OrchestrationCommandInvariantError> =>
  Effect.gen(function* () {
    const { command, readModel, occurredAt } = input;
    const thread = readModel.threads.find(
      (entry) => entry.id === command.threadId && entry.deletedAt === null,
    );
    if (thread === undefined) {
      return yield* reject(command, `Thread '${command.threadId}' does not exist.`);
    }
    const existing = thread.relatedThreads?.find(
      (link) => link.relatedThreadId === command.relatedThreadId,
    );

    if (command.type === "thread.related-thread.unlink") {
      // Unlinking never looks at the other thread: it may since have been
      // deleted or hidden, and the way out must stay open.
      if (existing === undefined) {
        return yield* reject(command, `Thread '${command.relatedThreadId}' is not linked.`);
      }
      return {
        type: "thread.related-thread-unlinked",
        payload: { threadId: command.threadId, relatedThreadId: command.relatedThreadId },
      };
    }

    if (command.relatedThreadId === command.threadId) {
      return yield* reject(command, "A thread cannot be related to itself.");
    }
    const related = readModel.threads.find(
      (entry) => entry.id === command.relatedThreadId && entry.deletedAt === null,
    );
    // One message for missing, foreign-project, and private threads so a
    // rejection cannot be used to probe for threads the owner cannot see.
    if (
      related === undefined ||
      related.projectId !== thread.projectId ||
      !(isThreadShared(related) || threadOwnerOf(related) === threadOwnerOf(thread))
    ) {
      return yield* reject(
        command,
        `Thread '${command.relatedThreadId}' is not a shared thread in this project.`,
      );
    }
    if (existing?.relationship === command.relationship) {
      return yield* reject(command, `Thread '${command.relatedThreadId}' is already linked.`);
    }
    return {
      type: "thread.related-thread-linked",
      payload: {
        threadId: command.threadId,
        link: {
          relatedThreadId: command.relatedThreadId,
          relationship: command.relationship,
          linkedAt: existing?.linkedAt ?? occurredAt,
        },
      },
    };
  });
