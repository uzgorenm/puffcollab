import {
  type EnvironmentId,
  type Member,
  type MemberId,
  PROJECT_BRIEF_MAX_LENGTH,
  PROJECT_MEMBER_FOCUS_MAX_LENGTH,
  type ProjectId,
  type TeamActivityItem,
  type TeamActivityPageResult,
  type TeamWorkCard,
  type TeamWorkCardStatus,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  appendOlderTeamActivity,
  deriveTeamWorkCards,
  TEAM_WORK_CARD_STATUS_LABELS,
  teamActivityHasActor,
  teamActivityPhrase,
  type TeamOverviewState,
} from "@t3tools/client-runtime/state/team-overview";
import { Link } from "@tanstack/react-router";
import { GitBranchIcon, UserPlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useCooperationProjectSummaries } from "../../state/cooperation";
import { useProject, useThreadShellsForProjectRefs } from "../../state/entities";
import { useEnvironmentMembers } from "../../state/members";
import { useEnvironmentQuery } from "../../state/query";
import { teamOverviewEnvironment, useTeamOverview } from "../../state/teamOverview";
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
import { openProjectPeopleDialog } from "./projectPeopleDialogStore";

type Members = ReadonlyMap<MemberId, Member>;

const memberName = (
  members: Members,
  memberId: MemberId | null,
  currentMemberId: MemberId | null,
) =>
  memberId === null
    ? "Someone"
    : memberId === currentMemberId
      ? "You"
      : (members.get(memberId)?.displayName ?? "A former member");

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
  overview,
  members,
  currentMemberId,
}: {
  environmentId: EnvironmentId;
  overview: TeamOverviewState;
  members: Members;
  currentMemberId: MemberId | null;
}) {
  const updateBrief = useAtomCommand(teamOverviewEnvironment.updateBrief);
  const [draft, setDraft] = useState<{ text: string; baseVersion: number | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const brief = overview.brief;

  const save = async () => {
    if (draft === null) return;
    setSaving(true);
    const result = await updateBrief({
      environmentId,
      input: {
        projectId: overview.projectId,
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
                Version {brief.version} by {memberName(members, brief.authorId, currentMemberId)},{" "}
                {formatRelativeTimeLabel(brief.createdAt)}
              </span>
            ) : null}
            <div className="flex-1" />
            {brief && brief.version > 1 ? (
              <Button size="xs" variant="ghost" onClick={() => setShowHistory((open) => !open)}>
                {showHistory ? "Hide history" : "History"}
              </Button>
            ) : null}
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
      {showHistory && brief ? (
        <BriefHistory
          environmentId={environmentId}
          projectId={overview.projectId}
          beforeVersion={brief.version}
          members={members}
          currentMemberId={currentMemberId}
        />
      ) : null}
    </Section>
  );
}

function BriefHistory({
  environmentId,
  projectId,
  beforeVersion,
  members,
  currentMemberId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  beforeVersion: number;
  members: Members;
  currentMemberId: MemberId | null;
}) {
  const history = useEnvironmentQuery(
    teamOverviewEnvironment.briefHistory({
      environmentId,
      input: { projectId, beforeVersion, limit: 20 },
    }),
  ).data;
  if (history === null) return <Spinner />;
  return (
    <ol className="flex flex-col gap-2">
      {history.versions.map((version) => (
        <li key={version.version} className="rounded-lg border border-dashed p-3">
          <div className="mb-1 text-muted-foreground text-xs">
            Version {version.version} by {memberName(members, version.authorId, currentMemberId)},{" "}
            {formatRelativeTimeLabel(version.createdAt)}
          </div>
          <p className="whitespace-pre-wrap text-sm">{version.text || "(empty)"}</p>
        </li>
      ))}
    </ol>
  );
}

function FocusList({
  environmentId,
  overview,
  members,
  currentMemberId,
}: {
  environmentId: EnvironmentId;
  overview: TeamOverviewState;
  members: Members;
  currentMemberId: MemberId | null;
}) {
  const setFocus = useAtomCommand(teamOverviewEnvironment.setFocus);
  const own = overview.focuses.find((focus) => focus.memberId === currentMemberId) ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (focus: string | null) => {
    setSaving(true);
    const result = await setFocus({
      environmentId,
      input: { projectId: overview.projectId, focus },
    });
    setSaving(false);
    if (result._tag === "Success") setDraft(null);
    else toastManager.add({ type: "error", title: "Could not update your focus" });
  };

  const others = overview.focuses.filter((focus) => focus.memberId !== currentMemberId);
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
              <li key={focus.memberId} className="flex flex-wrap gap-x-2 text-sm">
                <span className="font-medium">
                  {memberName(members, focus.memberId, currentMemberId)}
                </span>
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
  card,
  members,
  currentMemberId,
}: {
  environmentId: EnvironmentId;
  card: TeamWorkCard;
  members: Members;
  currentMemberId: MemberId | null;
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
        <span>{memberName(members, card.ownerId, currentMemberId)}</span>
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
  overview,
  members,
  currentMemberId,
  threadTitles,
}: {
  environmentId: EnvironmentId;
  overview: TeamOverviewState;
  members: Members;
  currentMemberId: MemberId | null;
  threadTitles: ReadonlyMap<string, string>;
}) {
  const loadPage = useAtomCommand(teamOverviewEnvironment.activityPage);
  const [older, setOlder] = useState<TeamActivityPageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const view = older === null ? overview : appendOlderTeamActivity(overview, older);
  const nextBeforeSequence = view.activityNextBeforeSequence;

  const loadOlder = async () => {
    if (nextBeforeSequence === null) return;
    setLoading(true);
    const result = await loadPage({
      environmentId,
      input: { projectId: overview.projectId, beforeSequence: nextBeforeSequence, limit: 30 },
    });
    setLoading(false);
    if (result._tag === "Success") {
      const page = result.value;
      setOlder((previous) => ({
        items: [...(previous?.items ?? []), ...page.items],
        nextBeforeSequence: page.nextBeforeSequence,
      }));
    }
  };

  const describe = (item: TeamActivityItem) => {
    const phrase = teamActivityPhrase(item.kind);
    return teamActivityHasActor(item.kind)
      ? `${memberName(members, item.actorId, currentMemberId)} ${phrase}`
      : phrase;
  };

  return (
    <Section title="Activity">
      {view.activity.length === 0 ? (
        <p className="text-muted-foreground text-sm">No recent activity.</p>
      ) : (
        <ol className="flex flex-col divide-y rounded-lg border bg-card">
          {view.activity.map((item) => {
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
      {nextBeforeSequence !== null ? (
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          disabled={loading}
          onClick={() => void loadOlder()}
        >
          {loading ? <Spinner /> : null}
          Load older
        </Button>
      ) : null}
    </Section>
  );
}

/**
 * The team view of one project: brief, everyone's focus, a work card per
 * visible thread, and recent activity.
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
  const projectRefs = useMemo(() => [projectRef], [projectRef]);
  const project = useProject(projectRef);
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const { members, currentMemberId } = useEnvironmentMembers(environmentId);
  const { overview, error } = useTeamOverview({ environmentId, projectId });
  const analysisByThreadId = useCooperationProjectSummaries(environmentId, projectId);

  const cards = useMemo(
    () =>
      currentMemberId === null
        ? []
        : deriveTeamWorkCards({
            threads,
            projectId,
            memberId: currentMemberId,
            analysisByThreadId,
          }),
    [analysisByThreadId, currentMemberId, projectId, threads],
  );
  const threadTitles = useMemo(
    () => new Map(threads.map((thread) => [thread.id as string, thread.title])),
    [threads],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <h1 className="min-w-0 flex-1 truncate font-medium text-sm">
          {project ? `${project.title} · Team` : "Team"}
        </h1>
        <Button
          size="xs"
          variant="outline"
          onClick={() => openProjectPeopleDialog({ environmentId, projectId })}
        >
          <UserPlusIcon />
          Invite people
        </Button>
      </WorkspacePageHeader>
      <div className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          {overview === null ? (
            error ? (
              <p className="text-destructive-foreground text-sm">{error}</p>
            ) : (
              <Spinner />
            )
          ) : (
            <>
              <BriefEditor
                environmentId={environmentId}
                overview={overview}
                members={members}
                currentMemberId={currentMemberId}
              />
              <FocusList
                environmentId={environmentId}
                overview={overview}
                members={members}
                currentMemberId={currentMemberId}
              />
              <Section title="Work">
                {cards.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No shared threads yet. Threads you own and threads teammates share show up here.
                  </p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {cards.map((card) => (
                      <WorkCardTile
                        key={card.threadId}
                        environmentId={environmentId}
                        card={card}
                        members={members}
                        currentMemberId={currentMemberId}
                      />
                    ))}
                  </div>
                )}
              </Section>
              <ActivityFeed
                environmentId={environmentId}
                overview={overview}
                members={members}
                currentMemberId={currentMemberId}
                threadTitles={threadTitles}
              />
            </>
          )}
        </WorkspacePageContainer>
      </div>
    </div>
  );
}
