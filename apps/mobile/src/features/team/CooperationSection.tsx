import {
  appendAwarenessNote,
  cooperationSettingsUpdate,
} from "@t3tools/client-runtime/state/cooperation";
import type {
  CooperationAwarenessAction,
  CooperationAwarenessItem,
  CooperationSettings,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { cooperationEnvironment, useCooperationThreadState } from "../../state/cooperation";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { TeamPillButton } from "./TeamPillButton";
import { TeamCardBody, TeamMutedText } from "./TeamRows";

/**
 * Cooperation analysis for one thread (Puff Collab): the latest summary for
 * everyone, and the owner's consent settings and "Analyze now". Choosing the
 * analysis model is an admin setting that stays on web and desktop.
 */
export function CooperationSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const state = useCooperationThreadState(props.environmentId, props.threadId).data;
  // Servers without cooperation analysis never answer; show nothing rather than a dead section.
  if (state === null) return null;
  return (
    <SettingsSection title="Cooperation analysis">
      <TeamCardBody>
        {state.summary ? (
          <Text className="text-sm text-foreground" selectable>
            {state.summary.summary}
          </Text>
        ) : (
          <TeamMutedText>No analysis yet.</TeamMutedText>
        )}
        {state.lastRun && state.lastRun.state !== "applied" ? (
          <Text className="text-xs text-foreground-muted">
            {`Last run ${state.lastRun.state}${state.lastRun.reason ? `: ${state.lastRun.reason}` : ""}`}
          </Text>
        ) : null}
        {state.canEdit ? null : (
          <Text className="text-xs text-foreground-muted">
            {`Analysis is ${state.settings.analysisEnabled ? "on" : "off"} for this thread. Only its owner can change that.`}
          </Text>
        )}
      </TeamCardBody>
      {state.canEdit ? (
        <CooperationSettingsForm environmentId={props.environmentId} settings={state.settings} />
      ) : null}
    </SettingsSection>
  );
}

function CooperationSettingsForm(props: {
  readonly environmentId: EnvironmentId;
  readonly settings: CooperationSettings;
}) {
  const { settings } = props;
  const updateSettings = useAtomCommand(
    cooperationEnvironment.updateSettings,
    "Update cooperation settings",
  );
  const runAnalysis = useAtomCommand(
    cooperationEnvironment.runAnalysis,
    "Run cooperation analysis",
  );
  // A draft only applies to the settings version it was typed against.
  const [topicDraft, setTopicDraft] = useState<{ version: number; value: string } | null>(null);
  const topic = topicDraft?.version === settings.version ? topicDraft.value : settings.featureTopic;
  const [pending, setPending] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const topicReady = topic.trim().length > 0;

  const save = async (patch: Parameters<typeof cooperationSettingsUpdate>[1]) => {
    setPending(true);
    await updateSettings({
      environmentId: props.environmentId,
      input: cooperationSettingsUpdate(settings, { featureTopic: topic, ...patch }),
    });
    setPending(false);
  };
  const saveTopic = () => {
    if (topic.trim() !== settings.featureTopic && (topicReady || !settings.analysisEnabled)) {
      void save({});
    }
  };

  return (
    <>
      <TeamCardBody divided>
        <Text className="text-xs font-t3-medium text-foreground-muted">Feature topic</Text>
        <AppTextInput
          value={topic}
          maxLength={80}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="e.g. billing"
          accessibilityLabel="Feature topic"
          returnKeyType="done"
          editable={!pending}
          onChangeText={(value) => setTopicDraft({ version: settings.version, value })}
          onBlur={saveTopic}
          onSubmitEditing={saveTopic}
        />
        <TeamMutedText>
          Two opted-in shared threads with the same topic are analyzed together.
        </TeamMutedText>
      </TeamCardBody>
      <View className="border-t border-border-subtle">
        <SettingsSwitchRow
          icon="sparkles"
          label="Share with analysis"
          subtitle={topicReady ? undefined : "Set a feature topic first"}
          disabled={pending || (!settings.analysisEnabled && !topicReady)}
          value={settings.analysisEnabled}
          onValueChange={(analysisEnabled) => void save({ analysisEnabled })}
        />
      </View>
      <SettingsSwitchRow
        icon="text.bubble"
        label="Include message text"
        subtitle="Redacted; otherwise only activity is shared"
        disabled={pending || !settings.analysisEnabled}
        value={settings.textEnabled}
        onValueChange={(textEnabled) => void save({ textEnabled })}
      />
      <SettingsSwitchRow
        icon="bell.badge"
        label="Notify me about related work"
        disabled={pending || !settings.analysisEnabled}
        value={settings.awarenessNotify}
        onValueChange={(awarenessNotify) => void save({ awarenessNotify })}
      />
      <TeamCardBody divided>
        <View className="flex-row justify-end">
          <TeamPillButton
            label="Analyze now"
            disabled={pending || !settings.analysisEnabled}
            loading={analyzing}
            onPress={async () => {
              setAnalyzing(true);
              await runAnalysis({
                environmentId: props.environmentId,
                input: { threadId: settings.threadId },
              });
              setAnalyzing(false);
            }}
          />
        </View>
      </TeamCardBody>
    </>
  );
}

/**
 * The owner's awareness notes and proposals for one thread. Admitting a note
 * only adds it to the composer draft, where the owner can still edit or
 * remove it; approving a proposal sends it as the owner's message.
 */
export function CooperationInboxSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly items: ReadonlyArray<CooperationAwarenessItem>;
  readonly onAdmitted: () => void;
}) {
  const resolveItem = useAtomCommand(
    cooperationEnvironment.resolveItem,
    "Resolve cooperation note",
  );
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  if (props.items.length === 0) return null;

  const resolve = async (item: CooperationAwarenessItem, action: CooperationAwarenessAction) => {
    setBusyItemId(item.itemId);
    const result = await resolveItem({
      environmentId: props.environmentId,
      input: { itemId: item.itemId, action },
    });
    setBusyItemId(null);
    if (result._tag !== "Success" || action !== "admit") return;
    const draftKey = scopedThreadKey(props.environmentId, props.threadId);
    setComposerDraftText(
      draftKey,
      appendAwarenessNote(getComposerDraftSnapshot(draftKey).text, item),
    );
    props.onAdmitted();
  };

  return (
    <SettingsSection title="For you">
      {props.items.map((item, index) => {
        const busy = busyItemId === item.itemId;
        return (
          <TeamCardBody key={item.itemId} divided={index > 0}>
            <Text className="text-xs text-foreground-muted">
              {`${item.kind === "proposal" ? "Proposed message" : "Note"} from ${item.sourceThreadTitle}`}
            </Text>
            <Text className="text-sm text-foreground" selectable>
              {item.text}
            </Text>
            <View className="flex-row flex-wrap justify-end gap-2 pt-1">
              {item.kind === "proposal" ? (
                <>
                  <TeamPillButton
                    label="Reject"
                    disabled={busy}
                    onPress={() => void resolve(item, "reject")}
                  />
                  <TeamPillButton
                    label="Send as my message"
                    tone="primary"
                    loading={busy}
                    onPress={() => void resolve(item, "approve")}
                  />
                </>
              ) : (
                <>
                  <TeamPillButton
                    label="Dismiss"
                    disabled={busy}
                    onPress={() => void resolve(item, "dismiss")}
                  />
                  <TeamPillButton
                    label="Add to my next message"
                    tone="primary"
                    loading={busy}
                    onPress={() => void resolve(item, "admit")}
                  />
                </>
              )}
            </View>
          </TeamCardBody>
        );
      })}
    </SettingsSection>
  );
}
