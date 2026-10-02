import type {
  EnvironmentId,
  OrchestrationThread,
  RelatedThreadRelationship,
  ThreadId,
} from "@t3tools/contracts";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { SettingsSection } from "../settings/components/SettingsSection";
import type { EnvironmentMembers } from "../../state/members";
import {
  relatedWorkEnvironment,
  useRelatedWorkSuggestions,
  useResolvedRelatedThreads,
} from "../../state/related-work";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  RELATED_THREAD_RELATIONSHIP_LABELS,
  RELATED_THREAD_STATUS_LABELS,
  teamMemberName,
} from "./team-presentation";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText, TeamRow } from "./TeamRows";

/**
 * Related work for one thread (Puff Collab): linked threads for everyone who
 * can see it, plus suggestions and link/unlink for its owner. Links are shown
 * to people and never sent to the agent.
 */
export function RelatedThreadsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly thread: Pick<
    OrchestrationThread,
    "projectId" | "title" | "messages" | "relatedThreads"
  > | null;
  readonly isOwner: boolean;
  readonly teamEnabled: boolean;
  readonly roster: EnvironmentMembers;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { thread, roster } = props;
  const resolved = useResolvedRelatedThreads(props.environmentId, thread?.relatedThreads);
  const link = useAtomCommand(relatedWorkEnvironment.link, "Link related thread");
  const unlink = useAtomCommand(relatedWorkEnvironment.unlink, "Unlink related thread");
  const canLink = props.isOwner && props.teamEnabled;
  const draftText = useMemo(() => {
    if (thread === null) return "";
    const firstUserMessage = thread.messages.find((message) => message.role === "user")?.text;
    return [thread.title, firstUserMessage ?? ""].join("\n");
  }, [thread]);
  const linkedIds = useMemo(
    () => new Set(resolved.map((entry) => entry.link.relatedThreadId)),
    [resolved],
  );
  const suggestions = useRelatedWorkSuggestions({
    environmentId: canLink ? props.environmentId : null,
    projectId: thread?.projectId ?? null,
    text: draftText,
    excludeThreadId: props.threadId,
  }).filter((suggestion) => !linkedIds.has(suggestion.threadId));

  if (thread === null || (resolved.length === 0 && !canLink)) return null;

  const ownerLabel = (memberId: Parameters<typeof teamMemberName>[1]) =>
    teamMemberName(roster.members, memberId, roster.currentMemberId);
  const linkTo = (relatedThreadId: ThreadId, relationship: RelatedThreadRelationship) =>
    void link({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, relatedThreadId, relationship },
    });

  return (
    <SettingsSection title="Related threads">
      {resolved.map((entry, index) => {
        const relationship = RELATED_THREAD_RELATIONSHIP_LABELS[entry.link.relationship];
        const unlinkButton = props.isOwner ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Unlink related thread"
            hitSlop={8}
            className="active:opacity-60"
            onPress={() =>
              void unlink({
                environmentId: props.environmentId,
                input: { threadId: props.threadId, relatedThreadId: entry.link.relatedThreadId },
              })
            }
          >
            <SymbolView name="xmark" size={14} tintColorClassName="accent-icon-subtle" />
          </Pressable>
        ) : null;
        return entry.kind === "visible" ? (
          <TeamRow
            key={entry.link.relatedThreadId}
            divided={index > 0}
            title={entry.title}
            detail={`${relationship} · ${ownerLabel(entry.createdBy)} · ${RELATED_THREAD_STATUS_LABELS[entry.status]}`}
            trailing={unlinkButton}
            onPress={() => props.onOpenThread(entry.link.relatedThreadId)}
          />
        ) : (
          <TeamRow
            key={entry.link.relatedThreadId}
            divided={index > 0}
            muted
            title="Unavailable thread"
            detail={relationship}
            trailing={unlinkButton}
          />
        );
      })}
      {canLink && suggestions.length > 0 ? (
        <>
          <TeamCardBody divided={resolved.length > 0}>
            <TeamMutedText>
              Possibly related shared threads. Linking shows the relationship to teammates; it is
              never sent to the agent.
            </TeamMutedText>
          </TeamCardBody>
          {suggestions.map((suggestion) => (
            <View key={suggestion.threadId} className="border-t border-border-subtle pb-3">
              <TeamRow
                title={suggestion.title}
                detail={ownerLabel(suggestion.createdBy)}
                onPress={() => props.onOpenThread(suggestion.threadId)}
              />
              <View className="flex-row gap-2 px-4">
                <TeamPillButton
                  label="Complementary"
                  accessibilityLabel={`Link ${suggestion.title} as complementary`}
                  onPress={() => linkTo(suggestion.threadId, "complementary")}
                />
                <TeamPillButton
                  label="Alternative"
                  accessibilityLabel={`Link ${suggestion.title} as an alternative`}
                  onPress={() => linkTo(suggestion.threadId, "alternative")}
                />
              </View>
            </View>
          ))}
        </>
      ) : canLink && resolved.length === 0 ? (
        <TeamCardBody>
          <TeamMutedText>No related shared threads found.</TeamMutedText>
        </TeamCardBody>
      ) : null}
    </SettingsSection>
  );
}
