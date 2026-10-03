import {
  HUB_URL_PLACEHOLDER,
  type HubStatusTone,
  hubStatusSummary,
  isHubLinked,
  parseHubUrlInput,
} from "@t3tools/client-runtime/state/hub";
import type { EnvironmentId, HubLocalStatus, HubPendingLink } from "@t3tools/contracts";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { hubEnvironment, useHubStatus } from "../../state/hub";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const TONE_DOT: Record<HubStatusTone, string> = {
  neutral: "bg-muted-foreground/50",
  positive: "bg-success",
  attention: "bg-warning",
  critical: "bg-destructive",
};

function openVerificationUrl(url: string) {
  const api = readLocalApi();
  if (!api) return;
  void api.shell.openExternal(url).catch(() => {
    toastManager.add({
      type: "error",
      title: "Could not open the hub",
      description: "Open the link shown under the code instead.",
    });
  });
}

function HubUrlRow({
  environmentId,
  status,
}: {
  environmentId: EnvironmentId;
  status: HubLocalStatus;
}) {
  const configure = useAtomCommand(hubEnvironment.configure);
  const saved = status.hubUrl ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = draft ?? saved;
  const parsed = parseHubUrlInput(value);
  const changed = parsed.ok ? parsed.hubUrl !== status.hubUrl : value.trim() !== saved;
  const linked = isHubLinked(status);

  const handleSave = async () => {
    if (!parsed.ok || !changed) return;
    if (linked) {
      const confirmed =
        (await readLocalApi()?.dialogs.confirm(
          "Changing the hub address unlinks this computer from its current hub. Continue?",
        )) ?? false;
      if (!confirmed) return;
    }
    setBusy(true);
    const result = await configure({ environmentId, input: { hubUrl: parsed.hubUrl } });
    setBusy(false);
    if (result._tag === "Success") setDraft(null);
  };

  return (
    <SettingsRow
      title="Hub address"
      description={
        !parsed.ok && value.trim() !== ""
          ? parsed.error
          : "Your team's hosted hub, or one running on your network."
      }
    >
      <form
        className="flex flex-wrap items-center gap-2 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSave();
        }}
      >
        <Input
          size="sm"
          className="min-w-0 flex-1"
          type="url"
          placeholder={HUB_URL_PLACEHOLDER}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Team hub address"
          autoComplete="off"
          spellCheck={false}
        />
        <Button size="sm" type="submit" disabled={busy || !parsed.ok || !changed}>
          Save
        </Button>
      </form>
    </SettingsRow>
  );
}

function PendingLinkCode({
  environmentId,
  pendingLink,
}: {
  environmentId: EnvironmentId;
  pendingLink: HubPendingLink;
}) {
  const linkCancel = useAtomCommand(hubEnvironment.linkCancel);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    target: "link code",
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  const expires = new Date(pendingLink.expiresAt);
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-xs">
      <p>Enter this code on the hub page, signed in with GitHub, to approve this computer.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-2 py-1 font-semibold text-base tracking-widest">
          {pendingLink.userCode}
        </code>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => copyToClipboard(pendingLink.userCode)}
        >
          {isCopied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => openVerificationUrl(pendingLink.verificationUrl)}
        >
          Open hub
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          onClick={() => void linkCancel({ environmentId, input: {} })}
        >
          Cancel
        </Button>
      </div>
      <a
        className="truncate text-muted-foreground underline-offset-2 hover:underline"
        href={pendingLink.verificationUrl}
        target="_blank"
        rel="noreferrer"
      >
        {pendingLink.verificationUrl}
      </a>
      {Number.isNaN(expires.getTime()) ? null : (
        <p className="text-muted-foreground">
          The code expires at {expires.toLocaleTimeString([], { timeStyle: "short" })}.
        </p>
      )}
    </div>
  );
}

function HubAccountRow({
  environmentId,
  status,
}: {
  environmentId: EnvironmentId;
  status: HubLocalStatus;
}) {
  const unlink = useAtomCommand(hubEnvironment.unlink);
  const account = status.account;
  if (account === null) return null;
  const projectCount = status.projects.length;
  const handleUnlink = async () => {
    const confirmed =
      (await readLocalApi()?.dialogs.confirm(
        "Unlink this computer from the team hub? Shared threads stop syncing and teammates' threads disappear from this computer until you link again.",
      )) ?? false;
    if (confirmed) void unlink({ environmentId, input: {} });
  };
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt=""
              className="size-5 rounded-full"
              referrerPolicy="no-referrer"
            />
          ) : null}
          <span>{account.displayName}</span>
          <span className="font-normal text-muted-foreground">@{account.githubLogin}</span>
        </span>
      }
      description={
        projectCount === 0
          ? "No projects linked yet. Link one from its menu or project settings."
          : projectCount === 1
            ? "1 project linked."
            : `${projectCount} projects linked.`
      }
      control={
        <Button size="xs" variant="ghost-destructive" onClick={() => void handleUnlink()}>
          Unlink
        </Button>
      }
    />
  );
}

function HubLinkRow({
  environmentId,
  status,
}: {
  environmentId: EnvironmentId;
  status: HubLocalStatus;
}) {
  const linkStart = useAtomCommand(hubEnvironment.linkStart);
  const [busy, setBusy] = useState(false);
  if (status.hubUrl === null || isHubLinked(status)) return null;
  const pendingLink = status.pendingLink;
  const handleLink = async () => {
    setBusy(true);
    const result = await linkStart({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") openVerificationUrl(result.value.verificationUrl);
  };
  return (
    <SettingsRow
      title="Link this computer"
      description="Sign in to the hub with GitHub and approve this computer."
      control={
        pendingLink === null ? (
          <Button size="sm" disabled={busy} onClick={() => void handleLink()}>
            Link this computer
          </Button>
        ) : null
      }
    >
      {pendingLink !== null ? (
        <div className="pt-2">
          <PendingLinkCode environmentId={environmentId} pendingLink={pendingLink} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

/**
 * Settings → Connections → Team hub (Stage 7): where this computer's local
 * server links to the team hub. Linking is host-wide: the environment owner
 * changes it.
 */
export function TeamHubSettings({ environmentId }: { environmentId: EnvironmentId | null }) {
  const status = useHubStatus(environmentId);
  if (environmentId === null || status === null) return null;
  const summary = hubStatusSummary(status);

  return (
    <SettingsSection id="team-hub" title="Team hub">
      <SettingsRow
        title="Status"
        description={summary.detail ?? undefined}
        control={
          <span className="flex items-center gap-1.5 text-xs">
            <span aria-hidden className={cn("size-2 rounded-full", TONE_DOT[summary.tone])} />
            {summary.label}
          </span>
        }
      />
      <HubUrlRow environmentId={environmentId} status={status} />
      <HubLinkRow environmentId={environmentId} status={status} />
      <HubAccountRow environmentId={environmentId} status={status} />
    </SettingsSection>
  );
}
