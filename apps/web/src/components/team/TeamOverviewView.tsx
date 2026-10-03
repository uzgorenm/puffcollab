import {
  type EnvironmentId,
  type HubLocalActivityItem,
  type HubLocalTeam,
  type HubLocalWorkCard,
  PROJECT_BRIEF_MAX_LENGTH,
  PROJECT_MEMBER_FOCUS_MAX_LENGTH,
  type ProjectId,
  type TeamWorkCardStatus,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  hubTeamMemberName,
  TEAM_WORK_CARD_STATUS_LABELS,
  teamActivityHasActor,
  teamActivityPhrase,
} from "@t3tools/client-runtime/state/team-overview";
import { Link } from "@tanstack/react-router";
import { GitBranchIcon, UserPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useProject } from "../../state/entities";
import { hubEnvironment, useHubProjectLink, useHubStatus, useHubTeam } from "../../state/hub";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HubProjectLinkPanel } from "./HubProjectDialog";
import { openProjectPeopleDialog } from "./projectPeopleDialogStore";

const STATUS_BADGE: Readonly<
  Record<TeamWorkCardStatus, "warning" | "info" | "error" | "success" | "secondary">
> = {
  "waiting-approval": "warning",
  "waiting-input": "warning",
  working: "info",
  errored: "error",
  settled: "success",
  idle: "secondary",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-medium text-muted-foreground text-sm">{title}</h2>
      {children}
    </section>
  );
}

function BriefEditor({
  environmentId,
  team,
}: {
  environmentId: EnvironmentId;
  team: HubLocalTeam;
}) {
  const updateBrief = useAtomCommand(hubEnvironment.updateBrief);
  const [draft, setDraft] = useState<{ text: string; baseVersion: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const brief = team.brief;

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const result = await updateBrief({
      environmentId,
      input: {
        projectId: team.projectId,
        text: draft.text.trim(),
        expectedVersion: draft.baseVersion,
      },
    });
    setSaving(false);
    if (result._tag === "Success") setDraft(null);
    else
      toastManager.add({
        type: "error",
        title: "Could not save the brief",
        description: "Someone may have edited it first. Your draft is kept; reload and retry.",
      });
  };

  return (
    <Section title="Project brief">
      {draft === null ? (
        <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
          {brief && brief.text.length > 0 ? (
            <p className="whitespace-pre-wrap text-sm">{brief.text}</p>
          ) : (
            <p className="text-muted-foreground text-sm">
              No brief yet. Describe what the team is building and what matters right now.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            {brief ? (
              <span>
                Version {brief.version} by {hubTeamMemberName(team, brief.authorId)},{" "}
                {formatRelativeTimeLabel(brief.createdAt)}
              </span>
            ) : null}
            <div className="flex-1" />
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                setDraft({ text: brief?.text ?? "", baseVersion: brief?.version ?? null })
              }
            >
              Edit
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft.text}
            maxLength={PROJECT_BRIEF_MAX_LENGTH}
            rows={8}
            aria-label="Project brief"
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button size="xs" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="xs" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : null}
              Save
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

function FocusList({ environmentId, team }: { environmentId: EnvironmentId; team: HubLocalTeam }) {
  const setFocus = useAtomCommand(hubEnvironment.setFocus);
  const own = team.focuses.find((focus) => focus.accountId === team.viewerAccountId) ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (focus: string | null) => {
    setSaving(true);
    const result = await setFocus({ environmentId, input: { projectId: team.projectId, focus } });
    setSaving(false);
    if (result._tag === "Success") setDraft(null);
    else toastManager.add({ type: "error", title: "Could not update your focus" });
  };

  const others = team.focuses.filter((focus) => focus.accountId !== team.viewerAccountId);
  const value = draft ?? own?.focus ?? "";
  return (
    <Section title="Current focus">
      <div className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            className="min-w-0 flex-1"
            placeholder="What are you working on?"
            aria-label="Your current focus"
            maxLength={PROJECT_MEMBER_FOCUS_MAX_LENGTH}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim()) void submit(value.trim());
            }}
          />
          <Button
            size="xs"
            disabled={saving || draft === null || !value.trim()}
            onClick={() => void submit(value.trim())}
          >
            Set
          </Button>
          {own ? (
            <Button size="xs" variant="ghost" disabled={saving} onClick={() => void submit(null)}>
              Clear
            </Button>
          ) : null}
        </div>
        {others.length > 0 ? (
          <ul className="flex flex-col gap-1.5 pt-1">
            {others.map((focus) => (
              <li key={focus.accountId} className="flex flex-wrap gap-x-2 text-sm">
                <span className="font-medium">{hubTeamMemberName(team, focus.accountId)}</span>
                <span className="min-w-0 flex-1">{focus.focus}</span>
                <span className="text-muted-foreground text-xs">
                  {formatRelativeTimeLabel(focus.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  );
}

function WorkCardTile({
  environmentId,
  team,
  card,
}: {
  environmentId: EnvironmentId;
  team: HubLocalTeam;
  card: HubLocalWorkCard;
}) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(environmentId, card.threadId))}
      className="flex flex-col gap-2 rounded-lg border bg-card p-3 hover:bg-accent/40"
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{card.title}</span>
        <Badge variant={STATUS_BADGE[card.status]}>
          {TEAM_WORK_CARD_STATUS_LABELS[card.status]}
        </Badge>
      </div>
      {card.analysis ? (
        <p className="line-clamp-3 text-muted-foreground text-sm">{card.analysis.summary}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        <span>{hubTeamMemberName(team, card.ownerId)}</span>
        <span>{formatRelativeTimeLabel(card.lastActivityAt)}</span>
        {card.branch ? (
          <span className="flex min-w-0 items-center gap-1">
            <GitBranchIcon className="size-3" aria-hidden />
            <span className="truncate">{card.branch}</span>
          </span>
        ) : null}
      </div>
    </Link>
  );
}

function ActivityFeed({
  environmentId,
  team,
}: {
  environmentId: EnvironmentId;
  team: HubLocalTeam;
}) {
  const threadTitles = useMemo(
    () => new Map(team.workCards.map((card) => [card.threadId as string, card.title])),
    [team.workCards],
  );
  const describe = (item: HubLocalActivityItem) => {
    const phrase = teamActivityPhrase(item.kind);
    return teamActivityHasActor(item.kind)
      ? `${hubTeamMemberName(team, item.actorId)} ${phrase}`
      : phrase;
  };

  return (
    <Section title="Activity">
      {team.activity.length === 0 ? (
        <p className="text-muted-foreground text-sm">No recent activity.</p>
      ) : (
        <ol className="flex flex-col divide-y rounded-lg border bg-card">
          {team.activity.map((item) => {
            const threadTitle = item.threadId ? threadTitles.get(item.threadId) : undefined;
            return (
              <li key={item.id} className="flex flex-col gap-0.5 px-3 py-2 text-sm">
                <div className="flex gap-2">
                  <span className="min-w-0 flex-1">
                    {describe(item)}
                    {item.threadId && threadTitle ? (
                      <>
                        {" in "}
                        <Link
                          to="/$environmentId/$threadId"
                          params={buildThreadRouteParams(
                            scopeThreadRef(environmentId, item.threadId),
                          )}
                          className="font-medium hover:underline"
                        >
                          {threadTitle}
                        </Link>
                      </>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {formatRelativeTimeLabel(item.occurredAt)}
                  </span>
                </div>
                {item.detail && item.kind !== "thread-created" ? (
                  <span className="truncate text-muted-foreground text-xs">{item.detail}</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

/**
 * The team view of a hub-linked project: brief, everyone's focus, a work card
 * per shared thread, and recent activity, all from the team hub. A project that
 * is not on the hub shows how to link it instead.
 */
export function TeamOverviewView({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  useEscapeToGoBack();
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId, projectId),
    [environmentId, projectId],
  );
  const project = useProject(projectRef);
  const status = useHubStatus(environmentId);
  const link = useHubProjectLink(environmentId, projectId);
  const team = useHubTeam(environmentId, projectId);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <h1 className="min-w-0 flex-1 truncate font-medium text-sm">
          {project ? `${project.title} · Team` : "Team"}
        </h1>
        {link !== null ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => openProjectPeopleDialog({ environmentId, projectId })}
          >
            <UserPlusIcon />
            People
          </Button>
        ) : null}
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          {link === null ? (
            <Section title="Team overview">
              <p className="text-muted-foreground text-sm">
                Team overview shows the brief, focus, shared work and activity of a project you
                share with teammates on the team hub.
              </p>
              <HubProjectLinkPanel environmentId={environmentId} projectId={projectId} />
            </Section>
          ) : team === null ? (
            status?.state === "online" ? (
              <Spinner />
            ) : (
              <p className="text-muted-foreground text-sm">
                Team overview appears once this computer reaches the team hub.
              </p>
            )
          ) : (
            <>
              <BriefEditor environmentId={environmentId} team={team} />
              <FocusList environmentId={environmentId} team={team} />
              <Section title="Work">
                {team.workCards.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No shared threads yet. Shared threads from you and your teammates show up here.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {team.workCards.map((card) => (
                      <WorkCardTile
                        key={card.hubThreadId}
                        environmentId={environmentId}
                        team={team}
                        card={card}
                      />
                    ))}
                  </div>
                )}
              </Section>
              <ActivityFeed environmentId={environmentId} team={team} />
            </>
          )}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
