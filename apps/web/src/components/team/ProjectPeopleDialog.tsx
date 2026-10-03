import {
  type EnvironmentId,
  type Member,
  type MemberCredentialResult,
  type MemberId,
  type ProjectId,
  type ProjectInvitation,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  canCancelInvitation,
  canRemoveProjectMember,
  invitableMembers,
} from "@t3tools/client-runtime/state/members";
import { useMemo, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useProject } from "../../state/entities";
import {
  memberEnvironment,
  useEnvironmentMembers,
  useIsEnvironmentAdmin,
} from "../../state/members";
import { useEnvironmentQuery } from "../../state/query";
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
import { toastManager } from "../ui/toast";
import { useIsHubLinked } from "../../state/hub";
import { HubProjectPeoplePanel } from "./HubProjectDialog";
import { useProjectPeopleDialogStore } from "./projectPeopleDialogStore";
import { type SignInUrlResolver, useSignInUrlResolver } from "./useSignInUrlResolver";

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const STATE_LABELS: Record<ProjectInvitation["state"], string> = {
  pending: "Invited",
  accepted: "Accepted",
  declined: "Declined",
  cancelled: "Cancelled",
  expired: "Expired",
};

function nameOf(members: ReadonlyMap<MemberId, Member>, memberId: MemberId) {
  return members.get(memberId)?.displayName ?? "A former member";
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="font-medium text-muted-foreground text-xs">{children}</h3>;
}

function SignInLink({
  credential,
  resolveSignInUrl,
  displayName,
}: {
  credential: MemberCredentialResult;
  resolveSignInUrl: SignInUrlResolver;
  displayName: string;
}) {
  const url = resolveSignInUrl(credential.credential);
  const value = url ?? credential.credential;
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    target: "sign-in link",
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-muted/40 p-2 text-xs">
      <p>
        Send {displayName} this sign-in link. After signing in they accept the invitation. One use,
        expires in 24 hours.
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5">{value}</code>
        <Button size="xs" variant="ghost-muted" onClick={() => copyToClipboard(value)}>
          {isCopied ? "Copied" : "Copy"}
        </Button>
      </div>
      {url === null ? (
        <p className="text-muted-foreground">
          A sign-in code: they paste it with this environment's address when adding it.
        </p>
      ) : null}
    </div>
  );
}

function NewPersonForm({
  environmentId,
  projectId,
  resolveSignInUrl,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  resolveSignInUrl: SignInUrlResolver;
}) {
  const invite = useAtomCommand(memberEnvironment.invite);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{
    readonly credential: MemberCredentialResult;
    readonly displayName: string;
  } | null>(null);
  const normalizedUsername = username.trim().toLowerCase();
  const canInvite =
    !busy &&
    displayName.trim().length > 0 &&
    (normalizedUsername === "" || USERNAME_PATTERN.test(normalizedUsername));

  const handleInvite = async () => {
    if (!canInvite) return;
    setBusy(true);
    const name = displayName.trim();
    const result = await invite({
      environmentId,
      input: {
        projectId,
        newPerson: {
          displayName: name,
          ...(normalizedUsername === "" ? {} : { username: normalizedUsername }),
        },
      },
    });
    setBusy(false);
    if (result._tag === "Success" && result.value.signIn !== undefined) {
      setIssued({ credential: result.value.signIn, displayName: name });
      setDisplayName("");
      setUsername("");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void handleInvite();
        }}
      >
        <Input
          size="sm"
          className="min-w-0 flex-1"
          placeholder="Name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-label="New person's name"
        />
        <Input
          size="sm"
          className="w-36"
          placeholder="username (optional)"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-label="New person's username"
        />
        <Button size="sm" type="submit" disabled={!canInvite}>
          Invite
        </Button>
      </form>
      {issued ? (
        <SignInLink
          credential={issued.credential}
          resolveSignInUrl={resolveSignInUrl}
          displayName={issued.displayName}
        />
      ) : null}
    </div>
  );
}

function ProjectPeoplePanel({
  environmentId,
  projectId,
  onLeft,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onLeft: () => void;
}) {
  const { members, currentMemberId } = useEnvironmentMembers(environmentId);
  const viewerIsAdmin = useIsEnvironmentAdmin(environmentId);
  const resolveSignInUrl = useSignInUrlResolver(environmentId);
  const projectMembers = useEnvironmentQuery(
    memberEnvironment.projectMembers({ environmentId, input: { projectId } }),
  ).data;
  const invitationsQuery = useEnvironmentQuery(
    memberEnvironment.projectInvitations({ environmentId, input: { projectId } }),
  );
  const invitations = invitationsQuery.data?.invitations ?? [];
  const invite = useAtomCommand(memberEnvironment.invite);
  const cancel = useAtomCommand(memberEnvironment.cancelInvitation);
  const leave = useAtomCommand(memberEnvironment.leaveProject);
  const remove = useAtomCommand(memberEnvironment.removeProjectMember);

  const memberIds = projectMembers?.memberIds ?? [];
  const viewerInProject =
    viewerIsAdmin || (currentMemberId !== null && memberIds.includes(currentMemberId));
  const candidates = useMemo(
    () =>
      invitableMembers({
        members,
        projectMemberIds: memberIds,
        invitations,
        viewerId: currentMemberId,
      }),
    [currentMemberId, invitations, memberIds, members],
  );
  const pending = invitations.filter((invitation) => invitation.state === "pending");
  // Recent answers, newest first, one per person.
  const answered = invitations.filter(
    (invitation, index) =>
      invitation.state !== "pending" &&
      invitation.state !== "accepted" &&
      invitations.findIndex((other) => other.inviteeId === invitation.inviteeId) === index,
  );

  if (!viewerInProject) {
    return (
      <p className="text-muted-foreground text-sm">
        {invitationsQuery.error ?? "You are not a member of this project."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <SectionTitle>Members</SectionTitle>
        {memberIds.length === 0 ? (
          <p className="text-muted-foreground text-sm">Admins see every project.</p>
        ) : (
          memberIds.map((memberId) => (
            <div key={memberId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {nameOf(members, memberId)}
                {memberId === currentMemberId ? " (you)" : ""}
                {memberId === projectMembers?.creatorId ? (
                  <span className="text-muted-foreground"> · created the project</span>
                ) : null}
              </span>
              {memberId === currentMemberId ? (
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={async () => {
                    const result = await leave({ environmentId, input: { projectId } });
                    if (result._tag === "Success" && !viewerIsAdmin) onLeft();
                  }}
                >
                  Leave
                </Button>
              ) : canRemoveProjectMember({
                  projectMembers,
                  viewerId: currentMemberId,
                  viewerIsAdmin,
                  targetId: memberId,
                }) ? (
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  onClick={() => void remove({ environmentId, input: { projectId, memberId } })}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))
        )}
      </section>

      {pending.length > 0 || answered.length > 0 ? (
        <section className="flex flex-col gap-2">
          <SectionTitle>Invitations</SectionTitle>
          {[...pending, ...answered].map((invitation) => {
            const invitee = members.get(invitation.inviteeId);
            const canReinvite =
              invitation.state !== "pending" &&
              candidates.some((member) => member.memberId === invitation.inviteeId);
            return (
              <div key={invitation.invitationId} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {nameOf(members, invitation.inviteeId)}
                  <span className="text-muted-foreground">
                    {" · "}
                    {STATE_LABELS[invitation.state]}
                    {invitee?.pending === true ? ", has not signed in yet" : ""}
                    {invitation.inviterId !== currentMemberId
                      ? ` by ${nameOf(members, invitation.inviterId)}`
                      : ""}
                  </span>
                </span>
                {canCancelInvitation({ invitation, viewerId: currentMemberId, viewerInProject }) ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      void cancel({
                        environmentId,
                        input: { invitationId: invitation.invitationId },
                      })
                    }
                  >
                    Cancel
                  </Button>
                ) : null}
                {canReinvite ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    onClick={() =>
                      void invite({
                        environmentId,
                        input: { projectId, memberId: invitation.inviteeId },
                      })
                    }
                  >
                    Invite again
                  </Button>
                ) : null}
              </div>
            );
          })}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <SectionTitle>Invite people</SectionTitle>
        {candidates.length === 0 ? (
          <p className="text-muted-foreground text-xs">Every teammate is in or invited.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {candidates.map((member) => (
              <div key={member.memberId} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {member.displayName}
                  <span className="text-muted-foreground"> @{member.username}</span>
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void invite({
                      environmentId,
                      input: { projectId, memberId: member.memberId },
                    })
                  }
                >
                  Invite
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="pt-1 text-muted-foreground text-xs">
          Someone new gets a member account and a one-time sign-in link.
        </p>
        <NewPersonForm
          environmentId={environmentId}
          projectId={projectId}
          resolveSignInUrl={resolveSignInUrl}
        />
      </section>
    </div>
  );
}

/** The project's members and invitations; opened from the thread menu, Team overview, and project settings. */
export function ProjectPeopleDialogHost() {
  const target = useProjectPeopleDialogStore((state) => state.target);
  const close = useProjectPeopleDialogStore((state) => state.close);
  const project = useProject(
    target === null ? null : scopeProjectRef(target.environmentId, target.projectId),
  );
  // Team hub (Stage 7): once linked, people are invited by GitHub login on the hub.
  const hubLinked = useIsHubLinked(target?.environmentId ?? null);
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
          <DialogTitle>People in {project?.title ?? "this project"}</DialogTitle>
          <DialogDescription>
            {hubLinked
              ? "Invite teammates to the hub project by GitHub login. They join once they accept."
              : "Invited people join once they accept. Anyone in the project can invite."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {hubLinked ? (
            <HubProjectPeoplePanel
              environmentId={target.environmentId}
              projectId={target.projectId}
              onNavigate={close}
            />
          ) : (
            <ProjectPeoplePanel
              environmentId={target.environmentId}
              projectId={target.projectId}
              onLeft={close}
            />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
