import {
  type EnvironmentId,
  type Member,
  type MemberCredentialResult,
  OWNER_MEMBER_ID,
  type ProjectId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useProjects } from "../../state/entities";
import { memberEnvironment, useEnvironmentMembers } from "../../state/members";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { resolveHostedPairingUrl } from "./pairingUrls";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Builds the link a teammate opens to sign in; null when only the code can be shared. */
type SignInUrlResolver = (credential: string) => string | null;

/**
 * The T3 Connect address of this environment, when the admin's client knows
 * it. Its HTTPS tunnel is reachable from anywhere, so a teammate can sign in
 * through the hosted app without being on the host's network.
 */
function useConnectSignInUrl(environmentId: EnvironmentId): SignInUrlResolver | null {
  const discovery = useRelayEnvironmentDiscovery();
  const httpBaseUrl = discovery.environments.get(environmentId)?.environment.endpoint.httpBaseUrl;
  return useMemo(
    () =>
      httpBaseUrl === undefined
        ? null
        : (credential: string) => resolveHostedPairingUrl(httpBaseUrl, credential),
    [httpBaseUrl],
  );
}

function AddMemberRow({ environmentId }: { environmentId: EnvironmentId }) {
  const addMember = useAtomCommand(memberEnvironment.add);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const normalizedUsername = username.trim().toLowerCase();
  const canAdd =
    !isAdding && USERNAME_PATTERN.test(normalizedUsername) && displayName.trim().length > 0;

  const handleAdd = async () => {
    if (!canAdd) return;
    setIsAdding(true);
    const result = await addMember({
      environmentId,
      input: {
        username: normalizedUsername,
        displayName: displayName.trim(),
        role: isAdmin ? "admin" : "member",
      },
    });
    setIsAdding(false);
    if (result._tag === "Success") {
      setUsername("");
      setDisplayName("");
      setIsAdmin(false);
    }
  };

  return (
    <SettingsRow
      title="Add member"
      description="Lowercase username, a display name, and whether they can manage the team."
    >
      <div className="flex flex-wrap items-center gap-2 pt-2">
        <Input
          size="sm"
          className="w-40"
          placeholder="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          aria-label="Username"
        />
        <Input
          size="sm"
          className="w-48"
          placeholder="Display name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          aria-label="Display name"
        />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={isAdmin} onCheckedChange={(checked) => setIsAdmin(checked === true)} />
          Admin
        </label>
        <Button size="sm" disabled={!canAdd} onClick={() => void handleAdd()}>
          Add
        </Button>
      </div>
    </SettingsRow>
  );
}

function ProjectMembershipToggle({
  environmentId,
  projectId,
  title,
  member,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  title: string;
  member: Member;
}) {
  const projectMembers = useEnvironmentQuery(
    memberEnvironment.projectMembers({ environmentId, input: { projectId } }),
  );
  const addProjectMember = useAtomCommand(memberEnvironment.addProjectMember);
  const removeProjectMember = useAtomCommand(memberEnvironment.removeProjectMember);
  const isMember = projectMembers.data?.memberIds.includes(member.memberId) ?? false;

  return (
    <label className="flex items-center gap-1.5 text-xs">
      <Checkbox
        checked={isMember}
        disabled={projectMembers.data === null}
        onCheckedChange={(checked) => {
          const command = checked === true ? addProjectMember : removeProjectMember;
          void command({ environmentId, input: { projectId, memberId: member.memberId } });
        }}
      />
      <span className="truncate">{title}</span>
    </label>
  );
}

function MemberRow({
  environmentId,
  member,
  resolveSignInUrl,
}: {
  environmentId: EnvironmentId;
  member: Member;
  resolveSignInUrl: SignInUrlResolver;
}) {
  const issueCredential = useAtomCommand(memberEnvironment.issueCredential);
  const revokeAccess = useAtomCommand(memberEnvironment.revokeAccess);
  const removeMember = useAtomCommand(memberEnvironment.remove);
  const projects = useProjects();
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const [credential, setCredential] = useState<MemberCredentialResult | null>(null);
  const [showProjects, setShowProjects] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    target: "sign-in link",
    onError: (error) =>
      toastManager.add({ type: "error", title: "Could not copy", description: error.message }),
  });
  const isOwner = member.memberId === OWNER_MEMBER_ID;
  const resolveConnectSignInUrl = useConnectSignInUrl(environmentId);
  const signInUrl = credential ? resolveSignInUrl(credential.credential) : null;
  const connectSignInUrl =
    credential && resolveConnectSignInUrl ? resolveConnectSignInUrl(credential.credential) : null;
  const primaryValue = signInUrl ?? connectSignInUrl ?? credential?.credential ?? "";

  const handleIssue = async () => {
    const result = await issueCredential({ environmentId, input: { memberId: member.memberId } });
    if (result._tag === "Success") setCredential(result.value);
  };

  return (
    <SettingsRow
      title={`${member.displayName} (@${member.username})`}
      description={member.role === "admin" ? "Admin" : "Member"}
      control={
        isOwner ? null : (
          <div className="flex items-center gap-1">
            {member.role !== "admin" ? (
              <Button size="xs" variant="ghost-muted" onClick={() => setShowProjects((v) => !v)}>
                Projects
              </Button>
            ) : null}
            <Button size="xs" variant="ghost-muted" onClick={() => void handleIssue()}>
              Sign-in link
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setCredential(null);
                void revokeAccess({ environmentId, input: { memberId: member.memberId } });
              }}
            >
              Sign out
            </Button>
            <Button
              size="xs"
              variant="ghost-destructive"
              onClick={() =>
                void removeMember({ environmentId, input: { memberId: member.memberId } })
              }
            >
              Remove
            </Button>
          </div>
        )
      }
    >
      {credential ? (
        <div className="flex flex-wrap items-center gap-2 pt-2 text-xs">
          <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5">{primaryValue}</code>
          <Button size="xs" variant="ghost-muted" onClick={() => copyToClipboard(primaryValue)}>
            {isCopied ? "Copied" : "Copy"}
          </Button>
          {signInUrl !== null && connectSignInUrl !== null && connectSignInUrl !== signInUrl ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => copyToClipboard(connectSignInUrl)}
            >
              Copy T3 Connect link
            </Button>
          ) : null}
          <span className="text-muted-foreground">
            {signInUrl === null && connectSignInUrl === null
              ? "A sign-in code: the teammate pastes it with this environment's address when adding it. One use, expires in 24 hours."
              : "One use, expires in 24 hours."}
          </span>
        </div>
      ) : null}
      {showProjects ? (
        <div className="grid gap-1.5 pt-2 sm:grid-cols-2">
          {environmentProjects.length === 0 ? (
            <p className="text-xs text-muted-foreground">No projects yet.</p>
          ) : (
            environmentProjects.map((project) => (
              <ProjectMembershipToggle
                key={project.id}
                environmentId={environmentId}
                projectId={project.id}
                title={project.title}
                member={member}
              />
            ))
          )}
        </div>
      ) : null}
    </SettingsRow>
  );
}

/**
 * Puff Collab team: admins add and remove members, mint their one-time
 * sign-in links, and choose which projects each member works in. Admins
 * see every project.
 */
export function TeamMembersSettings({
  environmentId,
  resolveSignInUrl,
}: {
  environmentId: EnvironmentId | null;
  resolveSignInUrl: SignInUrlResolver;
}) {
  const { members } = useEnvironmentMembers(environmentId);
  const activeMembers = useMemo(
    () => [...members.values()].filter((member) => member.removedAt === null),
    [members],
  );
  if (environmentId === null || members.size === 0) return null;

  return (
    <SettingsSection id="team-members" title="Team members">
      {activeMembers.map((member) => (
        <MemberRow
          key={member.memberId}
          environmentId={environmentId}
          member={member}
          resolveSignInUrl={resolveSignInUrl}
        />
      ))}
      <AddMemberRow environmentId={environmentId} />
    </SettingsSection>
  );
}
