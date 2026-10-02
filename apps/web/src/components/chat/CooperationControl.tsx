import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  appendAwarenessNote,
  cooperationSettingsUpdate,
} from "@t3tools/client-runtime/state/cooperation";
import type {
  CooperationAwarenessItem,
  CooperationRelationship,
  CooperationSettings,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { UsersRoundIcon } from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import {
  cooperationEnvironment,
  useCooperationInboxForThread,
  useCooperationThreadState,
} from "../../state/cooperation";
import { useEnvironmentMembers } from "../../state/members";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";

const RELATIONSHIP_LABELS: Record<CooperationRelationship, string> = {
  unspecified: "Unspecified",
  complementary: "Complementary",
  alternative: "Deliberate alternative",
};

/**
 * Puff Collab cooperation for one thread: the latest analysis summary, the
 * viewer's awareness notes for it, and (for the owner) the consent settings.
 * Hidden in single-person environments, where there is nobody to cooperate with.
 */
export function CooperationControl({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const { members } = useEnvironmentMembers(environmentId);
  if (members.size <= 1) return null;
  return <CooperationPopover environmentId={environmentId} threadId={threadId} />;
}

function CooperationPopover({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const state = useCooperationThreadState(environmentId, threadId).data;
  const items = useCooperationInboxForThread(environmentId, threadId);
  // Servers without cooperation analysis never answer; show nothing rather than a dead control.
  if (state === null) return null;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label="Cooperation analysis" />}
      >
        <span className="relative">
          <UsersRoundIcon className="size-4" />
          {items.length > 0 ? (
            <span className="absolute -right-1 -top-1 size-2 rounded-full bg-primary" />
          ) : null}
        </span>
      </PopoverTrigger>
      <PopoverPopup width="lg" align="end">
        <div className="flex flex-col gap-4">
          <PopoverTitle>Cooperation</PopoverTitle>
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-muted-foreground">Analysis summary</h3>
            {state.summary ? (
              <p className="text-sm">{state.summary.summary}</p>
            ) : (
              <p className="text-sm text-muted-foreground">No analysis yet.</p>
            )}
            {state.lastRun && state.lastRun.state !== "applied" ? (
              <p className="text-xs text-muted-foreground">
                Last run {state.lastRun.state}
                {state.lastRun.reason ? `: ${state.lastRun.reason}` : ""}
              </p>
            ) : null}
          </section>
          {items.length > 0 ? (
            <AwarenessItems environmentId={environmentId} threadId={threadId} items={items} />
          ) : null}
          {state.canEdit ? (
            <CooperationSettingsForm environmentId={environmentId} settings={state.settings} />
          ) : (
            <p className="text-xs text-muted-foreground">
              Analysis is {state.settings.analysisEnabled ? "on" : "off"} for this thread. Only its
              owner can change that.
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function AwarenessItems({
  environmentId,
  threadId,
  items,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  items: ReadonlyArray<CooperationAwarenessItem>;
}) {
  const resolveItem = useAtomCommand(cooperationEnvironment.resolveItem);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);

  const resolve = async (
    item: CooperationAwarenessItem,
    action: "admit" | "dismiss" | "approve" | "reject",
  ) => {
    setBusyItemId(item.itemId);
    const result = await resolveItem({
      environmentId,
      input: { itemId: item.itemId, action },
    });
    setBusyItemId(null);
    if (result._tag !== "Success" || action !== "admit") return;
    // Admitting only stages the note in the owner's composer; they decide to send it.
    const store = useComposerDraftStore.getState();
    const target = scopeThreadRef(environmentId, threadId);
    store.setPrompt(
      target,
      appendAwarenessNote(store.getComposerDraft(target)?.prompt ?? "", item),
    );
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">For you</h3>
      {items.map((item) => (
        <div key={item.itemId} className="flex flex-col gap-2 rounded-md border p-2">
          <p className="text-xs text-muted-foreground">
            {item.kind === "proposal" ? "Proposed message" : "Note"} from {item.sourceThreadTitle}
          </p>
          <p className="text-sm">{item.text}</p>
          <div className="flex justify-end gap-2">
            {item.kind === "proposal" ? (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busyItemId === item.itemId}
                  onClick={() => void resolve(item, "reject")}
                >
                  Reject
                </Button>
                <Button
                  size="xs"
                  disabled={busyItemId === item.itemId}
                  onClick={() => void resolve(item, "approve")}
                >
                  Send as my message
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busyItemId === item.itemId}
                  onClick={() => void resolve(item, "dismiss")}
                >
                  Dismiss
                </Button>
                <Button
                  size="xs"
                  disabled={busyItemId === item.itemId}
                  onClick={() => void resolve(item, "admit")}
                >
                  Add to my next message
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

function CooperationSettingsForm({
  environmentId,
  settings,
}: {
  environmentId: EnvironmentId;
  settings: CooperationSettings;
}) {
  const updateSettings = useAtomCommand(cooperationEnvironment.updateSettings);
  const runAnalysis = useAtomCommand(cooperationEnvironment.runAnalysis);
  const [topicDraft, setTopicDraft] = useState<{ version: number; value: string } | null>(null);
  const topic = topicDraft?.version === settings.version ? topicDraft.value : settings.featureTopic;
  const [pending, setPending] = useState(false);

  const save = async (patch: Parameters<typeof cooperationSettingsUpdate>[1]) => {
    setPending(true);
    await updateSettings({
      environmentId,
      input: cooperationSettingsUpdate(settings, { featureTopic: topic, ...patch }),
    });
    setPending(false);
  };

  const topicReady = topic.trim().length > 0;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-muted-foreground">Your thread's consent</h3>
      <label className="flex flex-col gap-1 text-xs">
        Feature topic
        <Input
          size="sm"
          value={topic}
          maxLength={80}
          placeholder="e.g. billing"
          onChange={(event) =>
            setTopicDraft({ version: settings.version, value: event.target.value })
          }
          onBlur={() => {
            if (
              topic.trim() !== settings.featureTopic &&
              (topicReady || !settings.analysisEnabled)
            ) {
              void save({});
            }
          }}
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">
        Relationship to other work
        <Select
          value={settings.relationship}
          onValueChange={(value) => void save({ relationship: value as CooperationRelationship })}
        >
          <SelectTrigger size="compact" className="w-44" aria-label="Relationship">
            <SelectValue>{RELATIONSHIP_LABELS[settings.relationship]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(RELATIONSHIP_LABELS).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      <ConsentSwitch
        label="Share this thread with cooperation analysis"
        checked={settings.analysisEnabled}
        disabled={pending || (!settings.analysisEnabled && !topicReady)}
        onChange={(analysisEnabled) => void save({ analysisEnabled })}
      />
      <ConsentSwitch
        label="Include message text (redacted), not just activity"
        checked={settings.textEnabled}
        disabled={pending || !settings.analysisEnabled}
        onChange={(textEnabled) => void save({ textEnabled })}
      />
      <ConsentSwitch
        label="Notify me about related work in other threads"
        checked={settings.awarenessNotify}
        disabled={pending || !settings.analysisEnabled}
        onChange={(awarenessNotify) => void save({ awarenessNotify })}
      />
      <div className="flex justify-end">
        <Button
          size="xs"
          variant="outline"
          disabled={pending || !settings.analysisEnabled}
          onClick={() =>
            void runAnalysis({ environmentId, input: { threadId: settings.threadId } })
          }
        >
          Analyze now
        </Button>
      </div>
    </section>
  );
}

function ConsentSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-xs">
      {label}
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
    </label>
  );
}
