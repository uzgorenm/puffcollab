import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  hasPendingHubInvitation,
  hubProjectLinkOf,
  isHubLinked,
  parseGithubLoginInput,
} from "@t3tools/client-runtime/state/hub";
import {
  canLeaveHubProject,
  canRemoveHubMember,
  type EnvironmentId,
  type HubLinkProjectResult,
  type HubLocalInvitation,
  type HubLocalTeam,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useProject } from "../../state/entities";
import { hubEnvironment, useHubInvitationGroups, useHubStatus, useHubTeam } from "../../state/hub";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { useHubProjectDialogStore } from "./hubProjectDialogStore";
import { openProjectPeopleDialog } from "./projectPeopleDialogStore";

type Alternatives = HubLinkProjectResult["alternatives"];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="font-medium text-muted-foreground text-xs">{children}</h3>;
}

/** Shown where hub features need this computer linked first. */
export function HubNotLinkedNotice({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 text-sm">
      <p className="text-muted-foreground">
        This computer isn't linked to a team hub yet. Link it in Settings, under Connections.
      </p>
      <Button
        size="xs"
        variant="outline"
        render={<Link to="/settings/connections" />}
        onClick={() => onNavigate?.()}
      >
        Open team hub settings
      </Button>
    </div>
  );
}

/**
 * Link a local project to the team hub, join a teammate's hub project for
 * the same repository instead, or unlink.
 */
export function HubProjectLinkPanel({
  environmentId,
  projectId,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onNavigate?: () => void;
}) {
  const status = useHubStatus(environmentId);
  const linkProject = useAtomCommand(hubEnvironment.linkProject);
  const unlinkProject = useAtomCommand(hubEnvironment.unlinkProject);
  const [busy, setBusy] = useState(false);
  // Alternatives come back with a link; keep them so "Join" stays offered.
  const [alternatives, setAlternatives] = useState<Alternatives>([]);
  const link = hubProjectLinkOf(status, projectId);

  if (status === null) {
    return <p className="text-muted-foreground text-sm">Checking the team hub…</p>;
  }
  if (!isHubLinked(status)) return <HubNotLinkedNotice {...(onNavigate ? { onNavigate } : {})} />;

  const handleLink = async (hubProjectId?: (typeof alternatives)[number]["hubProjectId"]) => {
    setBusy(true);
    const result = await linkProject({
      environmentId,
      input: hubProjectId === undefined ? { projectId } : { projectId, hubProjectId },
    });
    setBusy(false);
    if (result._tag === "Success") setAlternatives(result.value.alternatives);
  };

  const handleUnlink = async () => {
    setBusy(true);
    const result = await unlinkProject({ environmentId, input: { projectId } });
    setBusy(false);
    if (result._tag === "Success") setAlternatives([]);
  };

  const otherProjects = alternatives.filter(
    (alternative) => alternative.hubProjectId !== link?.hubProjectId,
  );

  return (
    <div className="flex flex-col gap-4 text-sm">
      {link === null ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted-foreground">
            Linking shares this project's shared threads with teammates who join it on the hub.
            Private threads never leave this computer.
          </p>
          <Button size="sm" disabled={busy} onClick={() => void handleLink()}>
            Link to team hub
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            Linked to <strong>{link.hubProjectTitle}</strong>
          </span>
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={busy}
            onClick={() => void handleUnlink()}
          >
            Unlink
          </Button>
        </div>
      )}
      {otherProjects.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Teammates already have this repository on the hub</SectionTitle>
          {otherProjects.map((alternative) => (
            <div key={alternative.hubProjectId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{alternative.title}</span>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => void handleLink(alternative.hubProjectId)}
              >
                Join {alternative.title}
              </Button>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function OutgoingInvitationRow({
  environmentId,
  invitation,
}: {
  environmentId: EnvironmentId;
  invitation: HubLocalInvitation;
}) {
  const cancel = useAtomCommand(hubEnvironment.cancelInvitation);
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate">
        @{invitation.inviteeLogin}
        <span className="text-muted-foreground"> · invited</span>
      </span>
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={() =>
          void cancel({ environmentId, input: { invitationId: invitation.invitationId } })
        }
      >
        Cancel
      </Button>
    </div>
  );
}

/** The hub project's members, with Remove for admins and Leave for everyone but the creator. */
function HubTeamMembersSection({
  environmentId,
  projectId,
  team,
  onLeft,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  team: HubLocalTeam;
  onLeft?: () => void;
}) {
  const remove = useAtomCommand(hubEnvironment.removeMember);
  const leave = useAtomCommand(hubEnvironment.leaveProject);
  const [busy, setBusy] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <SectionTitle>Members</SectionTitle>
      {team.members.map((member) => {
        const isViewer = member.accountId === team.viewerAccountId;
        return (
          <div key={member.accountId} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {member.displayName}
              <span className="text-muted-foreground">
                {" "}
                @{member.githubLogin}
                {isViewer ? " (you)" : ""}
                {member.accountId === team.creatorId
                  ? " · created the project"
                  : member.role === "admin"
                    ? " · admin"
                    : ""}
              </span>
            </span>
            {isViewer && canLeaveHubProject(team) ? (
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const result = await leave({ environmentId, input: { projectId } });
                  setBusy(false);
                  if (result._tag === "Success") onLeft?.();
                }}
              >
                Leave
              </Button>
            ) : canRemoveHubMember(team, member) ? (
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={busy}
                onClick={() =>
                  void remove({
                    environmentId,
                    input: { projectId, accountId: member.accountId },
                  })
                }
              >
                Remove
              </Button>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/** Invite by GitHub login into a hub-linked project, and cancel pending invitations. */
export function HubProjectPeoplePanel({
  environmentId,
  projectId,
  onNavigate,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onNavigate?: () => void;
}) {
  const status = useHubStatus(environmentId);
  const groups = useHubInvitationGroups(environmentId);
  const team = useHubTeam(environmentId, projectId);
  const invite = useAtomCommand(hubEnvironment.invite);
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState(false);
  const link = hubProjectLinkOf(status, projectId);
  if (link === null) {
    return <HubProjectLinkPanel environmentId={environmentId} projectId={projectId} />;
  }
  const outgoing = groups.outgoingByProject.get(link.hubProjectId) ?? [];
  const parsed = parseGithubLoginInput(login);
  const alreadyInvited = parsed !== null && hasPendingHubInvitation(outgoing, parsed);
  const canInvite = !busy && parsed !== null && !alreadyInvited;

  const handleInvite = async () => {
    if (!canInvite || parsed === null) return;
    setBusy(true);
    const result = await invite({ environmentId, input: { projectId, githubLogin: parsed } });
    setBusy(false);
    if (result._tag === "Success") setLogin("");
  };

  return (
    <div className="flex flex-col gap-5">
      {team !== null ? (
        <HubTeamMembersSection
          environmentId={environmentId}
          projectId={projectId}
          team={team}
          {...(onNavigate ? { onLeft: onNavigate } : {})}
        />
      ) : null}
      <section className="flex flex-col gap-2">
        <SectionTitle>Invite by GitHub login</SectionTitle>
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void handleInvite();
          }}
        >
          <Input
            size="sm"
            className="min-w-0 flex-1"
            placeholder="github-login"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            aria-label="GitHub login"
            autoComplete="off"
            spellCheck={false}
          />
          <Button size="sm" type="submit" disabled={!canInvite}>
            Invite
          </Button>
        </form>
        <p className="text-muted-foreground text-xs">
          {alreadyInvited
            ? "Already invited."
            : "They accept from their own Puff Collab once they sign in to the hub with GitHub."}
        </p>
      </section>
      {outgoing.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Pending invitations</SectionTitle>
          {outgoing.map((invitation) => (
            <OutgoingInvitationRow
              key={invitation.invitationId}
              environmentId={environmentId}
              invitation={invitation}
            />
          ))}
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <SectionTitle>Team hub</SectionTitle>
        <HubProjectLinkPanel
          environmentId={environmentId}
          projectId={projectId}
          {...(onNavigate ? { onNavigate } : {})}
        />
      </section>
    </div>
  );
}

/** The project's team hub link; opened from the thread menu, command palette and project settings. */
export function HubProjectDialogHost() {
  const target = useHubProjectDialogStore((state) => state.target);
  const close = useHubProjectDialogStore((state) => state.close);
  const project = useProject(
    target === null ? null : scopeProjectRef(target.environmentId, target.projectId),
  );
  if (target === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Team hub · {project?.title ?? "this project"}</DialogTitle>
          <DialogDescription>
            Teammates in the hub project follow and comment on its shared threads.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <HubProjectLinkPanel
            environmentId={target.environmentId}
            projectId={target.projectId}
            onNavigate={close}
          />
          <HubLinkedProjectFooter target={target} onClose={close} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function HubLinkedProjectFooter({
  target,
  onClose,
}: {
  target: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId };
  onClose: () => void;
}) {
  const status = useHubStatus(target.environmentId);
  if (hubProjectLinkOf(status, target.projectId) === null) return null;
  return (
    <div className="pt-4">
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          onClose();
          openProjectPeopleDialog(target);
        }}
      >
        Invite people
      </Button>
    </div>
  );
}
