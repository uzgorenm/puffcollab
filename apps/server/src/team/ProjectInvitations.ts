/**
 * ProjectInvitations - how people get into a Puff Collab project.
 *
 * Creating a project makes you a member of it (see ProjectionPipeline).
 * Everyone else joins through an invitation they accept: any project member
 * invites a teammate, or a new person, who gets a pending member account and
 * a one-time sign-in link. The invitee accepts or declines; the inviter,
 * project members, and admins can cancel while it is pending. Members leave
 * projects themselves; the project's creator and admins remove them.
 *
 * A pending account whose link expires or is revoked before anyone redeems
 * it is removed, and its invitations expire. That sweep runs lazily whenever
 * invitations or the roster are read, so no timer is needed.
 *
 * @module ProjectInvitations
 */
import {
  MemberId,
  type Member,
  type MemberCredentialResult,
  OWNER_MEMBER_ID,
  PROJECT_INVITATION_PENDING_LIMIT,
  ProjectId,
  type ProjectInvitation,
  ProjectInvitationId,
  type ProjectInvitationInviteInput,
  type ProjectInvitationInviteResult,
  ProjectInvitationsError,
  type ProjectInvitationsListResult,
  type ProjectInvitationState,
  type ProjectMembersResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as TeamAccess from "./TeamAccess.ts";

type Reason = ProjectInvitationsError["reason"];

const fail = (reason: Reason, message: string) =>
  Effect.fail(new ProjectInvitationsError({ reason, message }));

const fromTeamAccessError = (error: TeamAccess.TeamAccessError): ProjectInvitationsError =>
  new ProjectInvitationsError({
    reason:
      error._tag === "TeamUsernameTakenError"
        ? "username-taken"
        : error._tag === "TeamMemberNotFoundError"
          ? "not-found"
          : "internal",
    message: error.message,
  });

const PROJECT_INVITATION_LIST_LIMIT = 100;

const isProjectInvitationsError = Schema.is(ProjectInvitationsError);

export class ProjectInvitations extends Context.Service<
  ProjectInvitations,
  {
    readonly invite: (
      actor: MemberId,
      input: ProjectInvitationInviteInput,
    ) => Effect.Effect<ProjectInvitationInviteResult, ProjectInvitationsError>;
    /** Pending invitations addressed to the member. */
    readonly listMine: (
      actor: MemberId,
    ) => Effect.Effect<ProjectInvitationsListResult, ProjectInvitationsError>;
    /** Recent invitations to one project; project members and admins only. */
    readonly listForProject: (
      actor: MemberId,
      projectId: ProjectId,
    ) => Effect.Effect<ProjectInvitationsListResult, ProjectInvitationsError>;
    readonly accept: (
      actor: MemberId,
      invitationId: ProjectInvitationId,
    ) => Effect.Effect<ProjectInvitation, ProjectInvitationsError>;
    readonly decline: (
      actor: MemberId,
      invitationId: ProjectInvitationId,
    ) => Effect.Effect<ProjectInvitation, ProjectInvitationsError>;
    readonly cancel: (
      actor: MemberId,
      invitationId: ProjectInvitationId,
    ) => Effect.Effect<ProjectInvitation, ProjectInvitationsError>;
    readonly leaveProject: (
      actor: MemberId,
      projectId: ProjectId,
    ) => Effect.Effect<ProjectMembersResult, ProjectInvitationsError>;
    readonly removeProjectMember: (
      actor: MemberId,
      input: { readonly projectId: ProjectId; readonly memberId: MemberId },
    ) => Effect.Effect<ProjectMembersResult, ProjectInvitationsError>;
    /** The member's pending invitations now and after every change to them. */
    readonly subscribeMine: (
      actor: MemberId,
    ) => Stream.Stream<ProjectInvitationsListResult, ProjectInvitationsError>;
    /** The roster, after removing pending accounts whose link lapsed unredeemed. */
    readonly listMembers: () => Effect.Effect<ReadonlyArray<Member>, ProjectInvitationsError>;
    /**
     * Removes pending accounts whose sign-in link expired or was revoked
     * unredeemed, and settles invitations whose invitee is gone.
     */
    readonly sweepPendingAccounts: () => Effect.Effect<void, ProjectInvitationsError>;
  }
>()("t3/team/ProjectInvitations") {}

interface InvitationRow {
  readonly invitationId: string;
  readonly projectId: string;
  readonly projectTitle: string | null;
  readonly inviterId: string;
  readonly inviteeId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

const toState = (state: string): ProjectInvitationState =>
  state === "accepted" ||
  state === "declined" ||
  state === "cancelled" ||
  state === "expired" ||
  state === "pending"
    ? state
    : "cancelled";

const toInvitation = (row: InvitationRow): ProjectInvitation => ({
  invitationId: ProjectInvitationId.make(row.invitationId),
  projectId: ProjectId.make(row.projectId),
  projectTitle: row.projectTitle ?? "",
  inviterId: MemberId.make(row.inviterId),
  inviteeId: MemberId.make(row.inviteeId),
  state: toState(row.state),
  createdAt: row.createdAt,
  resolvedAt: row.resolvedAt,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const crypto = yield* Crypto.Crypto;
  const teamAccess = yield* TeamAccess.TeamAccess;
  // Members whose own pending invitations changed.
  const changes = yield* PubSub.unbounded<MemberId>();

  const internal =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, ProjectInvitationsError, R> =>
      effect.pipe(
        Effect.mapError((cause) =>
          isProjectInvitationsError(cause)
            ? cause
            : new ProjectInvitationsError({
                reason: "internal",
                message: `Project invitations failed during ${operation}.`,
              }),
        ),
        Effect.tapCause((cause) =>
          Effect.logDebug("project invitations operation failed", { operation, cause }),
        ),
      );

  const selectInvitations = sql`
    SELECT
      invitations.invitation_id AS "invitationId",
      invitations.project_id AS "projectId",
      projects.title AS "projectTitle",
      invitations.inviter_id AS "inviterId",
      invitations.invitee_id AS "inviteeId",
      invitations.state,
      invitations.created_at AS "createdAt",
      invitations.resolved_at AS "resolvedAt"
    FROM team_project_invitations AS invitations
    LEFT JOIN projection_projects AS projects ON projects.project_id = invitations.project_id
  `;

  const findInvitation = (invitationId: ProjectInvitationId) =>
    sql<InvitationRow>`${selectInvitations} WHERE invitations.invitation_id = ${invitationId}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : toInvitation(rows[0]))),
      internal("findInvitation"),
    );

  const requirePending = (invitationId: ProjectInvitationId) =>
    findInvitation(invitationId).pipe(
      Effect.flatMap((invitation) =>
        invitation === undefined
          ? fail("not-found", "This invitation does not exist.")
          : invitation.state !== "pending"
            ? fail("not-pending", `This invitation was already ${invitation.state}.`)
            : Effect.succeed(invitation),
      ),
    );

  const isProjectMember = (memberId: MemberId, projectId: ProjectId) =>
    teamAccess.isProjectMember(memberId, projectId).pipe(internal("isProjectMember"));

  const requireProjectMember = (memberId: MemberId, projectId: ProjectId) =>
    isProjectMember(memberId, projectId).pipe(
      Effect.flatMap((member) =>
        member ? Effect.void : fail("forbidden", "Only members of this project can do that."),
      ),
    );

  const requireLiveProject = (projectId: ProjectId) =>
    sql<{ readonly title: string }>`
      SELECT title FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
    `.pipe(
      internal("requireLiveProject"),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? fail("not-found", "This project does not exist.")
          : Effect.succeed(rows[0].title),
      ),
    );

  const settle = (invitationId: ProjectInvitationId, state: ProjectInvitationState) =>
    Effect.gen(function* () {
      const resolvedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE team_project_invitations
        SET state = ${state}, resolved_at = ${resolvedAt}
        WHERE invitation_id = ${invitationId} AND state = 'pending'
      `;
    }).pipe(internal("settle"));

  const notify = (memberId: MemberId) => PubSub.publish(changes, memberId).pipe(Effect.asVoid);

  const sweepPendingAccounts: ProjectInvitations["Service"]["sweepPendingAccounts"] = () =>
    Effect.gen(function* () {
      const pending = yield* sql<{ readonly memberId: string; readonly linkId: string }>`
        SELECT member_id AS "memberId", invite_link_id AS "linkId"
        FROM team_members
        WHERE invite_link_id IS NOT NULL AND removed_at IS NULL
      `;
      if (pending.length > 0) {
        const activeLinkIds = new Set(
          (yield* auth.listPairingLinks({ excludeSubjects: [] })).map((link) => link.id),
        );
        const sessionSubjects = new Set((yield* auth.listSessions()).map((s) => s.subject));
        for (const row of pending) {
          const memberId = MemberId.make(row.memberId);
          if (sessionSubjects.has(TeamAccess.memberSubject(memberId))) {
            yield* teamAccess.activatePendingMember(memberId);
          } else if (!activeLinkIds.has(row.linkId)) {
            yield* teamAccess.removeMember(memberId);
          }
        }
      }
      // Invitations to or from removed members can no longer be resolved.
      const resolvedAt = DateTime.formatIso(yield* DateTime.now);
      const settled = yield* sql<{ readonly inviteeId: string }>`
        UPDATE team_project_invitations
        SET state = 'expired', resolved_at = ${resolvedAt}
        WHERE state = 'pending' AND (
          invitee_id IN (SELECT member_id FROM team_members WHERE removed_at IS NOT NULL)
          OR inviter_id IN (SELECT member_id FROM team_members WHERE removed_at IS NOT NULL)
        )
        RETURNING invitee_id AS "inviteeId"
      `;
      yield* Effect.forEach(settled, (row) => notify(MemberId.make(row.inviteeId)), {
        discard: true,
      });
    }).pipe(internal("sweepPendingAccounts"));

  const listMine: ProjectInvitations["Service"]["listMine"] = (actor) =>
    sweepPendingAccounts().pipe(
      Effect.andThen(
        sql<InvitationRow>`
          ${selectInvitations}
          WHERE invitations.invitee_id = ${actor} AND invitations.state = 'pending'
          ORDER BY invitations.created_at DESC, invitations.invitation_id ASC
          LIMIT ${PROJECT_INVITATION_LIST_LIMIT}
        `.pipe(internal("listMine")),
      ),
      Effect.map((rows) => ({ invitations: rows.map(toInvitation) })),
    );

  const listForProject: ProjectInvitations["Service"]["listForProject"] = (actor, projectId) =>
    Effect.gen(function* () {
      yield* requireProjectMember(actor, projectId);
      yield* sweepPendingAccounts();
      const rows = yield* sql<InvitationRow>`
        ${selectInvitations}
        WHERE invitations.project_id = ${projectId}
        ORDER BY invitations.created_at DESC, invitations.invitation_id ASC
        LIMIT ${PROJECT_INVITATION_LIST_LIMIT}
      `.pipe(internal("listForProject"));
      return { invitations: rows.map(toInvitation) };
    });

  const insertInvitation = (input: {
    readonly projectId: ProjectId;
    readonly projectTitle: string;
    readonly inviterId: MemberId;
    readonly inviteeId: MemberId;
  }) =>
    Effect.gen(function* () {
      const invitationId = ProjectInvitationId.make(yield* crypto.randomUUIDv4);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO team_project_invitations
          (invitation_id, project_id, inviter_id, invitee_id, state, created_at, resolved_at)
        VALUES
          (${invitationId}, ${input.projectId}, ${input.inviterId}, ${input.inviteeId}, 'pending', ${createdAt}, NULL)
      `;
      return {
        invitationId,
        projectId: input.projectId,
        projectTitle: input.projectTitle,
        inviterId: input.inviterId,
        inviteeId: input.inviteeId,
        state: "pending",
        createdAt,
        resolvedAt: null,
      } satisfies ProjectInvitation;
    }).pipe(internal("insertInvitation"));

  const invite: ProjectInvitations["Service"]["invite"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireProjectMember(actor, input.projectId);
      const projectTitle = yield* requireLiveProject(input.projectId);
      yield* sweepPendingAccounts();
      const outstanding = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM team_project_invitations
        WHERE inviter_id = ${actor} AND state = 'pending'
      `.pipe(internal("countPending"));
      if ((outstanding[0]?.count ?? 0) >= PROJECT_INVITATION_PENDING_LIMIT) {
        return yield* fail(
          "limit-reached",
          `You already have ${PROJECT_INVITATION_PENDING_LIMIT} pending invitations. Cancel some or wait for answers first.`,
        );
      }

      let inviteeId: MemberId;
      let signIn: MemberCredentialResult | undefined;
      if ("memberId" in input) {
        inviteeId = input.memberId;
        if (inviteeId === actor) {
          return yield* fail("already-member", "You are already in this project.");
        }
        const roster = yield* teamAccess.listMembers().pipe(internal("listMembers"));
        const invitee = roster.find((member) => member.memberId === inviteeId);
        if (invitee === undefined || invitee.removedAt !== null) {
          return yield* fail("not-found", "That person is not a member of this environment.");
        }
        if (yield* isProjectMember(inviteeId, input.projectId)) {
          return yield* fail(
            "already-member",
            invitee.role === "admin"
              ? `${invitee.displayName} is an admin and already sees every project.`
              : `${invitee.displayName} is already in this project.`,
          );
        }
        const existing = yield* sql<{ readonly one: number }>`
          SELECT 1 AS "one" FROM team_project_invitations
          WHERE project_id = ${input.projectId} AND invitee_id = ${inviteeId} AND state = 'pending'
          LIMIT 1
        `.pipe(internal("findExisting"));
        if (existing.length > 0) {
          return yield* fail("already-invited", `${invitee.displayName} is already invited.`);
        }
      } else {
        const created = yield* teamAccess
          .addPendingMember({
            displayName: input.newPerson.displayName,
            username: input.newPerson.username,
            invitedBy: actor,
          })
          .pipe(Effect.mapError(fromTeamAccessError));
        inviteeId = created.member.memberId;
        signIn = created.credential;
      }

      const invitation = yield* insertInvitation({
        projectId: input.projectId,
        projectTitle,
        inviterId: actor,
        inviteeId,
      });
      yield* notify(inviteeId);
      return signIn === undefined ? { invitation } : { invitation, signIn };
    });

  const accept: ProjectInvitations["Service"]["accept"] = (actor, invitationId) =>
    Effect.gen(function* () {
      const invitation = yield* requirePending(invitationId);
      if (invitation.inviteeId !== actor) {
        return yield* fail("forbidden", "Only the invited person can accept this invitation.");
      }
      const live = yield* requireLiveProject(invitation.projectId).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => error.reason === "not-found",
          () => Effect.succeed(false),
        ),
      );
      if (!live) {
        yield* settle(invitationId, "cancelled");
        yield* notify(actor);
        return yield* fail("not-found", "This project no longer exists.");
      }
      yield* settle(invitationId, "accepted");
      // Publishes a visibility change, so the member's shell resends with the project.
      yield* teamAccess
        .addProjectMember({ projectId: invitation.projectId, memberId: actor })
        .pipe(Effect.mapError(fromTeamAccessError));
      yield* notify(actor);
      return (yield* findInvitation(invitationId)) ?? invitation;
    });

  const decline: ProjectInvitations["Service"]["decline"] = (actor, invitationId) =>
    Effect.gen(function* () {
      const invitation = yield* requirePending(invitationId);
      if (invitation.inviteeId !== actor) {
        return yield* fail("forbidden", "Only the invited person can decline this invitation.");
      }
      yield* settle(invitationId, "declined");
      yield* notify(actor);
      return (yield* findInvitation(invitationId)) ?? invitation;
    });

  const cancel: ProjectInvitations["Service"]["cancel"] = (actor, invitationId) =>
    Effect.gen(function* () {
      const invitation = yield* requirePending(invitationId);
      if (invitation.inviterId !== actor) {
        yield* requireProjectMember(actor, invitation.projectId);
      }
      yield* settle(invitationId, "cancelled");
      // A person invited from outside the team who never signed in, and has
      // nothing else waiting for them, loses their pending account and link.
      const invitee = yield* sql<{ readonly pending: number; readonly others: number }>`
        SELECT
          (invite_link_id IS NOT NULL AND removed_at IS NULL) AS "pending",
          (
            SELECT COUNT(*) FROM team_project_invitations
            WHERE invitee_id = ${invitation.inviteeId} AND state = 'pending'
          ) AS "others"
        FROM team_members
        WHERE member_id = ${invitation.inviteeId}
      `.pipe(internal("cancel:invitee"));
      const row = invitee[0];
      if (row !== undefined && row.pending === 1 && row.others === 0) {
        yield* teamAccess.removeMember(invitation.inviteeId).pipe(Effect.ignore);
      }
      yield* notify(invitation.inviteeId);
      return (yield* findInvitation(invitationId)) ?? invitation;
    });

  const listProjectMembers = (projectId: ProjectId) =>
    teamAccess.listProjectMembers(projectId).pipe(internal("listProjectMembers"));

  const leaveProject: ProjectInvitations["Service"]["leaveProject"] = (actor, projectId) =>
    teamAccess.removeProjectMember({ projectId, memberId: actor }).pipe(internal("leaveProject"));

  const removeProjectMember: ProjectInvitations["Service"]["removeProjectMember"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      if (input.memberId === actor) return yield* leaveProject(actor, input.projectId);
      if (input.memberId === OWNER_MEMBER_ID) {
        return yield* fail("forbidden", "The environment owner cannot be removed from a project.");
      }
      const isAdmin = yield* teamAccess.isAdmin(actor).pipe(internal("isAdmin"));
      if (!isAdmin) {
        const members = yield* listProjectMembers(input.projectId);
        const isCreator =
          members.creatorId === actor && members.memberIds.some((memberId) => memberId === actor);
        if (!isCreator) {
          return yield* fail(
            "forbidden",
            "Only the project's creator and admins can remove members.",
          );
        }
      }
      return yield* teamAccess.removeProjectMember(input).pipe(internal("removeProjectMember"));
    });

  const subscribeMine: ProjectInvitations["Service"]["subscribeMine"] = (actor) =>
    Stream.concat(
      Stream.fromEffect(listMine(actor)),
      Stream.fromPubSub(changes).pipe(
        Stream.filter((memberId) => memberId === actor),
        Stream.mapEffect(() => listMine(actor)),
      ),
    );

  const listMembers: ProjectInvitations["Service"]["listMembers"] = () =>
    sweepPendingAccounts().pipe(
      Effect.andThen(teamAccess.listMembers().pipe(internal("listMembers"))),
    );

  return ProjectInvitations.of({
    invite,
    listMine,
    listForProject,
    accept,
    decline,
    cancel,
    leaveProject,
    removeProjectMember,
    subscribeMine,
    listMembers,
    sweepPendingAccounts,
  });
});

export const layer = Layer.effect(ProjectInvitations, make);
