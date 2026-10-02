/**
 * TeamAccess - Puff Collab team identity, project membership, and the
 * authorization helpers other features build on.
 *
 * Every authenticated session resolves to one member. Sessions issued from a
 * member credential carry the subject `member:<memberId>`; every other session
 * (desktop bootstrap, startup pairing, owner-paired devices, CLI tokens)
 * resolves to the implicit owner, an admin. A single-user environment
 * therefore behaves exactly as before.
 *
 * Admins see every project. Other members see the projects they belong to:
 * the ones they created and the ones an admin added them to.
 *
 * @module TeamAccess
 */
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  type Member,
  type MemberCredentialResult,
  MemberId,
  type MemberRole,
  type MembersAddInput,
  type MembersRevokeAccessResult,
  OWNER_MEMBER_ID,
  ProjectId,
  type ProjectMembersResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

const MEMBER_SUBJECT_PREFIX = "member:";
const MEMBER_CREDENTIAL_TTL = Duration.hours(24);

/** The auth-session subject a member credential issues. */
export const memberSubject = (memberId: MemberId): string => `${MEMBER_SUBJECT_PREFIX}${memberId}`;

/**
 * The member an auth-session subject acts as. Non-member subjects are the
 * environment owner's own sessions.
 */
const memberIdForSubject = (subject: string): MemberId =>
  subject.startsWith(MEMBER_SUBJECT_PREFIX) && subject.length > MEMBER_SUBJECT_PREFIX.length
    ? MemberId.make(subject.slice(MEMBER_SUBJECT_PREFIX.length))
    : OWNER_MEMBER_ID;

export class TeamMemberNotFoundError extends Schema.TaggedError<TeamMemberNotFoundError>()(
  "TeamMemberNotFoundError",
  { memberId: Schema.String },
) {
  override get message(): string {
    return `Team member ${this.memberId} does not exist or was removed.`;
  }
}

export class TeamUsernameTakenError extends Schema.TaggedError<TeamUsernameTakenError>()(
  "TeamUsernameTakenError",
  { username: Schema.String },
) {
  override get message(): string {
    return `The username ${this.username} is already taken.`;
  }
}

export class TeamOwnerImmutableError extends Schema.TaggedError<TeamOwnerImmutableError>()(
  "TeamOwnerImmutableError",
  {},
) {
  override get message(): string {
    return "The environment owner cannot be removed or issued a member credential.";
  }
}

export class TeamPersistenceError extends Schema.TaggedError<TeamPersistenceError>()(
  "TeamPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Team access storage failed during ${this.operation}.`;
  }
}

export class TeamCredentialError extends Schema.TaggedError<TeamCredentialError>()(
  "TeamCredentialError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to issue or revoke a member credential.";
  }
}

export type TeamAccessError =
  | TeamMemberNotFoundError
  | TeamUsernameTakenError
  | TeamOwnerImmutableError
  | TeamPersistenceError
  | TeamCredentialError;

/** Which projects a member can see. Admins see all of them. */
export type TeamProjectVisibility =
  | { readonly all: true }
  | { readonly all: false; readonly projectIds: ReadonlySet<ProjectId> };

export const canSeeProject = (visibility: TeamProjectVisibility, projectId: ProjectId): boolean =>
  visibility.all || visibility.projectIds.has(projectId);

/** Keep only the projects (and their threads) a member can see. */
export const filterByProjectVisibility = <
  S extends {
    readonly projects: ReadonlyArray<{ readonly id: ProjectId }>;
    readonly threads: ReadonlyArray<{ readonly projectId: ProjectId }>;
  },
>(
  snapshot: S,
  visibility: TeamProjectVisibility,
): S =>
  visibility.all
    ? snapshot
    : {
        ...snapshot,
        projects: snapshot.projects.filter((project) => canSeeProject(visibility, project.id)),
        threads: snapshot.threads.filter((thread) => canSeeProject(visibility, thread.projectId)),
      };

export class TeamAccess extends Context.Service<
  TeamAccess,
  {
    /** The member a session acts as. Fails for removed or unknown members. */
    readonly resolveSessionMember: (session: {
      readonly subject: string;
    }) => Effect.Effect<Member, TeamMemberNotFoundError | TeamPersistenceError>;
    readonly isAdmin: (memberId: MemberId) => Effect.Effect<boolean, TeamPersistenceError>;
    /** Admins are members of every project. */
    readonly isProjectMember: (
      memberId: MemberId,
      projectId: ProjectId,
    ) => Effect.Effect<boolean, TeamPersistenceError>;
    readonly projectVisibility: (
      memberId: MemberId,
    ) => Effect.Effect<TeamProjectVisibility, TeamPersistenceError>;
    /**
     * Whether the member can see the thread, i.e. is a member of its project.
     * Unknown threads report true so callers keep their own not-found handling.
     */
    readonly canSeeThread: (
      memberId: MemberId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, TeamPersistenceError>;
    /** Whether the member created (owns) the thread. Threads without a creator have no owner. */
    readonly isThreadCreator: (
      memberId: MemberId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, TeamPersistenceError>;
    /** Members whose project visibility or access just changed. */
    readonly visibilityChanges: Stream.Stream<MemberId>;

    readonly listMembers: () => Effect.Effect<ReadonlyArray<Member>, TeamPersistenceError>;
    readonly addMember: (
      input: MembersAddInput,
    ) => Effect.Effect<Member, TeamUsernameTakenError | TeamPersistenceError>;
    /** Removes the member and revokes their sessions and unredeemed credentials. */
    readonly removeMember: (memberId: MemberId) => Effect.Effect<Member, TeamAccessError>;
    /** Mints a one-time pairing credential whose session acts as the member. */
    readonly issueMemberCredential: (
      memberId: MemberId,
    ) => Effect.Effect<MemberCredentialResult, TeamAccessError>;
    /** Revokes the member's sessions and unredeemed credentials without removing them. */
    readonly revokeMemberAccess: (
      memberId: MemberId,
    ) => Effect.Effect<MembersRevokeAccessResult, TeamAccessError>;

    readonly listProjectMembers: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectMembersResult, TeamPersistenceError>;
    readonly addProjectMember: (input: {
      readonly projectId: ProjectId;
      readonly memberId: MemberId;
    }) => Effect.Effect<ProjectMembersResult, TeamMemberNotFoundError | TeamPersistenceError>;
    readonly removeProjectMember: (input: {
      readonly projectId: ProjectId;
      readonly memberId: MemberId;
    }) => Effect.Effect<ProjectMembersResult, TeamPersistenceError>;
  }
>()("t3/team/TeamAccess") {}

interface MemberRow {
  readonly memberId: string;
  readonly username: string;
  readonly displayName: string;
  readonly role: string;
  readonly createdAt: string;
  readonly removedAt: string | null;
}

const toMember = (row: MemberRow): Member => ({
  memberId: MemberId.make(row.memberId),
  username: row.username,
  displayName: row.displayName,
  role: row.role === "admin" ? "admin" : "member",
  createdAt: row.createdAt,
  removedAt: row.removedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.unbounded<MemberId>();

  const persistence =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, TeamPersistenceError, R> =>
      effect.pipe(Effect.mapError((cause) => new TeamPersistenceError({ operation, cause })));

  const findMember = (memberId: MemberId) =>
    sql<MemberRow>`
      SELECT
        member_id AS "memberId",
        username,
        display_name AS "displayName",
        role,
        created_at AS "createdAt",
        removed_at AS "removedAt"
      FROM team_members
      WHERE member_id = ${memberId}
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toMember(rows[0]))),
      persistence("findMember"),
    );

  const requireActiveMember = (memberId: MemberId) =>
    findMember(memberId).pipe(
      Effect.flatMap((member) =>
        member === undefined || member.removedAt !== null
          ? Effect.fail(new TeamMemberNotFoundError({ memberId }))
          : Effect.succeed(member),
      ),
    );

  const resolveSessionMember: TeamAccess["Service"]["resolveSessionMember"] = (session) =>
    requireActiveMember(memberIdForSubject(session.subject));

  const roleOf = (memberId: MemberId): Effect.Effect<MemberRole | null, TeamPersistenceError> =>
    findMember(memberId).pipe(
      Effect.map((member) =>
        member === undefined || member.removedAt !== null ? null : member.role,
      ),
    );

  const isAdmin: TeamAccess["Service"]["isAdmin"] = (memberId) =>
    roleOf(memberId).pipe(Effect.map((role) => role === "admin"));

  const isProjectMember: TeamAccess["Service"]["isProjectMember"] = (memberId, projectId) =>
    Effect.gen(function* () {
      const role = yield* roleOf(memberId);
      if (role === null) return false;
      if (role === "admin") return true;
      const rows = yield* sql<{ readonly one: number }>`
        SELECT 1 AS "one"
        FROM team_project_members
        WHERE project_id = ${projectId} AND member_id = ${memberId}
        LIMIT 1
      `.pipe(persistence("isProjectMember"));
      return rows.length > 0;
    });

  const projectVisibility: TeamAccess["Service"]["projectVisibility"] = (memberId) =>
    Effect.gen(function* () {
      const role = yield* roleOf(memberId);
      if (role === "admin") return { all: true } as const;
      if (role === null) return { all: false, projectIds: new Set<ProjectId>() } as const;
      const rows = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId"
        FROM team_project_members
        WHERE member_id = ${memberId}
      `.pipe(persistence("projectVisibility"));
      return {
        all: false,
        projectIds: new Set(rows.map((row) => ProjectId.make(row.projectId))),
      } as const;
    });

  const canSeeThread: TeamAccess["Service"]["canSeeThread"] = (memberId, threadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM projection_threads WHERE thread_id = ${threadId}
      `.pipe(persistence("canSeeThread"));
      const row = rows[0];
      return row === undefined
        ? true
        : yield* isProjectMember(memberId, ProjectId.make(row.projectId));
    });

  const isThreadCreator: TeamAccess["Service"]["isThreadCreator"] = (memberId, threadId) =>
    sql<{ readonly createdBy: string | null }>`
      SELECT created_by AS "createdBy"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `.pipe(
      Effect.map((rows) => rows[0]?.createdBy === memberId),
      persistence("isThreadCreator"),
    );

  const listMembers: TeamAccess["Service"]["listMembers"] = () =>
    sql<MemberRow>`
      SELECT
        member_id AS "memberId",
        username,
        display_name AS "displayName",
        role,
        created_at AS "createdAt",
        removed_at AS "removedAt"
      FROM team_members
      ORDER BY (member_id = ${OWNER_MEMBER_ID}) DESC, created_at ASC, member_id ASC
    `.pipe(
      Effect.map((rows) => rows.map(toMember)),
      persistence("listMembers"),
    );

  const addMember: TeamAccess["Service"]["addMember"] = (input) =>
    Effect.gen(function* () {
      const taken = yield* sql<{ readonly one: number }>`
        SELECT 1 AS "one" FROM team_members
        WHERE username = ${input.username} AND removed_at IS NULL
        LIMIT 1
      `.pipe(persistence("addMember:checkUsername"));
      if (taken.length > 0) {
        return yield* new TeamUsernameTakenError({ username: input.username });
      }
      const memberId = MemberId.make(
        yield* crypto.randomUUIDv4.pipe(persistence("addMember:memberId")),
      );
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO team_members (member_id, username, display_name, role, created_at, removed_at)
        VALUES (${memberId}, ${input.username}, ${input.displayName}, ${input.role}, ${createdAt}, NULL)
      `.pipe(persistence("addMember:insert"));
      return {
        memberId,
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        createdAt,
        removedAt: null,
      } satisfies Member;
    });

  const revokeAccessFor = (memberId: MemberId) =>
    Effect.gen(function* () {
      const subject = memberSubject(memberId);
      const links = yield* auth.listPairingLinks({ excludeSubjects: [] });
      const sessions = yield* auth.listSessions();
      const memberLinks = links.filter((link) => link.subject === subject);
      const memberSessions = sessions.filter((session) => session.subject === subject);
      yield* Effect.forEach(memberLinks, (link) => auth.revokePairingLink(link.id), {
        discard: true,
      });
      yield* Effect.forEach(memberSessions, (session) => auth.revokeSession(session.sessionId), {
        discard: true,
      });
      return {
        revokedSessions: memberSessions.length,
        revokedCredentials: memberLinks.length,
      } satisfies MembersRevokeAccessResult;
    }).pipe(Effect.mapError((cause) => new TeamCredentialError({ cause })));

  const rejectOwner = (memberId: MemberId) =>
    memberId === OWNER_MEMBER_ID ? Effect.fail(new TeamOwnerImmutableError({})) : Effect.void;

  const removeMember: TeamAccess["Service"]["removeMember"] = (memberId) =>
    Effect.gen(function* () {
      yield* rejectOwner(memberId);
      const member = yield* requireActiveMember(memberId);
      const removedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE team_members SET removed_at = ${removedAt} WHERE member_id = ${memberId}
      `.pipe(persistence("removeMember"));
      yield* revokeAccessFor(memberId);
      yield* PubSub.publish(changes, memberId);
      return { ...member, removedAt };
    });

  const issueMemberCredential: TeamAccess["Service"]["issueMemberCredential"] = (memberId) =>
    Effect.gen(function* () {
      yield* rejectOwner(memberId);
      const member = yield* requireActiveMember(memberId);
      const issued = yield* auth
        .createPairingLink({
          subject: memberSubject(memberId),
          scopes: member.role === "admin" ? AuthAdministrativeScopes : AuthStandardClientScopes,
          label: member.displayName,
          ttl: MEMBER_CREDENTIAL_TTL,
        })
        .pipe(Effect.mapError((cause) => new TeamCredentialError({ cause })));
      return {
        id: issued.id,
        credential: issued.credential,
        expiresAt: issued.expiresAt,
      } satisfies MemberCredentialResult;
    });

  const revokeMemberAccess: TeamAccess["Service"]["revokeMemberAccess"] = (memberId) =>
    Effect.gen(function* () {
      yield* rejectOwner(memberId);
      const member = yield* findMember(memberId);
      if (member === undefined) {
        return yield* new TeamMemberNotFoundError({ memberId });
      }
      const result = yield* revokeAccessFor(memberId);
      yield* PubSub.publish(changes, memberId);
      return result;
    });

  const listProjectMembers: TeamAccess["Service"]["listProjectMembers"] = (projectId) =>
    sql<{ readonly memberId: string }>`
      SELECT project_members.member_id AS "memberId"
      FROM team_project_members AS project_members
      JOIN team_members AS members ON members.member_id = project_members.member_id
      WHERE project_members.project_id = ${projectId} AND members.removed_at IS NULL
      ORDER BY project_members.added_at ASC, project_members.member_id ASC
    `.pipe(
      Effect.map((rows) => ({
        projectId,
        memberIds: rows.map((row) => MemberId.make(row.memberId)),
      })),
      persistence("listProjectMembers"),
    );

  const addProjectMember: TeamAccess["Service"]["addProjectMember"] = ({ projectId, memberId }) =>
    Effect.gen(function* () {
      yield* requireActiveMember(memberId);
      const addedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR IGNORE INTO team_project_members (project_id, member_id, added_at)
        VALUES (${projectId}, ${memberId}, ${addedAt})
      `.pipe(persistence("addProjectMember"));
      yield* PubSub.publish(changes, memberId);
      return yield* listProjectMembers(projectId);
    });

  const removeProjectMember: TeamAccess["Service"]["removeProjectMember"] = ({
    projectId,
    memberId,
  }) =>
    Effect.gen(function* () {
      yield* sql`
        DELETE FROM team_project_members
        WHERE project_id = ${projectId} AND member_id = ${memberId}
      `.pipe(persistence("removeProjectMember"));
      yield* PubSub.publish(changes, memberId);
      return yield* listProjectMembers(projectId);
    });

  return TeamAccess.of({
    resolveSessionMember,
    isAdmin,
    isProjectMember,
    projectVisibility,
    canSeeThread,
    isThreadCreator,
    visibilityChanges: Stream.fromPubSub(changes),
    listMembers,
    addMember,
    removeMember,
    issueMemberCredential,
    revokeMemberAccess,
    listProjectMembers,
    addProjectMember,
    removeProjectMember,
  });
});

export const layer = Layer.effect(TeamAccess, make);
