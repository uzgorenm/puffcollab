import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type MemberId,
  OWNER_MEMBER_ID,
  PROJECT_INVITATION_PENDING_LIMIT,
  ProjectId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ProjectInvitations from "./ProjectInvitations.ts";
import * as TeamAccess from "./TeamAccess.ts";

const testLayer = ProjectInvitations.layer.pipe(
  Layer.provideMerge(TeamAccess.layer),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-invitations-test-" })),
);

const projectA = ProjectId.make("project-a");

/** A project created by `creator`, as ProjectionPipeline records it. */
const createProject = (projectId: ProjectId, creator: MemberId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const team = yield* TeamAccess.TeamAccess;
    const now = "2026-01-01T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
      VALUES (${projectId}, ${`Title ${projectId}`}, ${`/tmp/${projectId}`}, '[]', ${now}, ${now}, NULL)
    `;
    yield* sql`
      INSERT INTO team_project_creators (project_id, member_id) VALUES (${projectId}, ${creator})
    `;
    yield* team.addProjectMember({ projectId, memberId: creator });
  });

const addMember = (username: string) =>
  TeamAccess.TeamAccess.pipe(
    Effect.flatMap((team) =>
      team.addMember({ username, displayName: username.toUpperCase(), role: "member" }),
    ),
  );

const canSee = (memberId: MemberId, projectId: ProjectId) =>
  TeamAccess.TeamAccess.pipe(
    Effect.flatMap((team) => team.projectVisibility(memberId)),
    Effect.map((visibility) => TeamAccess.canSeeProject(visibility, projectId)),
  );

it.layer(NodeServices.layer)("ProjectInvitations", (it) => {
  it.effect("a member's invitation takes effect only when the invitee accepts", () =>
    Effect.gen(function* () {
      const invitations = yield* ProjectInvitations.ProjectInvitations;
      const team = yield* TeamAccess.TeamAccess;
      const ada = yield* addMember("ada");
      const bob = yield* addMember("bob");
      yield* createProject(projectA, ada.memberId);

      const changed = yield* team.visibilityChanges.pipe(
        Stream.filter((memberId) => memberId === bob.memberId),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );

      const { invitation, signIn } = yield* invitations.invite(ada.memberId, {
        projectId: projectA,
        memberId: bob.memberId,
      });
      expect(signIn).toBeUndefined();
      expect(invitation).toMatchObject({
        projectTitle: "Title project-a",
        inviterId: ada.memberId,
        inviteeId: bob.memberId,
        state: "pending",
      });
      expect(yield* canSee(bob.memberId, projectA)).toBe(false);
      expect((yield* invitations.listMine(bob.memberId)).invitations).toHaveLength(1);
      expect(
        (yield* invitations.listForProject(ada.memberId, projectA)).invitations.map((i) => i.state),
      ).toEqual(["pending"]);

      // Only the invitee answers.
      const stolen = yield* Effect.flip(invitations.accept(ada.memberId, invitation.invitationId));
      expect(stolen.reason).toBe("forbidden");

      const accepted = yield* invitations.accept(bob.memberId, invitation.invitationId);
      expect(accepted.state).toBe("accepted");
      expect(accepted.resolvedAt).not.toBeNull();
      expect(yield* canSee(bob.memberId, projectA)).toBe(true);
      // The shell's resend path hears about it.
      yield* Fiber.join(changed);
      expect((yield* invitations.listMine(bob.memberId)).invitations).toEqual([]);

      const again = yield* Effect.flip(
        invitations.invite(ada.memberId, { projectId: projectA, memberId: bob.memberId }),
      );
      expect(again.reason).toBe("already-member");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.effect("declines, cancels, and re-invites", () =>
    Effect.gen(function* () {
      const invitations = yield* ProjectInvitations.ProjectInvitations;
      const ada = yield* addMember("ada");
      const bob = yield* addMember("bob");
      const cy = yield* addMember("cy");
      yield* createProject(projectA, ada.memberId);
      const target = { projectId: projectA, memberId: bob.memberId };

      const first = (yield* invitations.invite(ada.memberId, target)).invitation;
      const duplicate = yield* Effect.flip(invitations.invite(ada.memberId, target));
      expect(duplicate.reason).toBe("already-invited");
      expect((yield* invitations.decline(bob.memberId, first.invitationId)).state).toBe("declined");
      const answeredTwice = yield* Effect.flip(
        invitations.accept(bob.memberId, first.invitationId),
      );
      expect(answeredTwice.reason).toBe("not-pending");

      // Re-invite after a decline; a non-member cannot cancel it.
      const second = (yield* invitations.invite(ada.memberId, target)).invitation;
      const outsider = yield* Effect.flip(invitations.cancel(cy.memberId, second.invitationId));
      expect(outsider.reason).toBe("forbidden");
      expect((yield* invitations.cancel(ada.memberId, second.invitationId)).state).toBe(
        "cancelled",
      );

      // Re-invite after a cancel; an admin can cancel any invitation.
      const third = (yield* invitations.invite(ada.memberId, target)).invitation;
      expect((yield* invitations.cancel(OWNER_MEMBER_ID, third.invitationId)).state).toBe(
        "cancelled",
      );
      expect(
        (yield* invitations.listForProject(ada.memberId, projectA)).invitations
          .map((i) => i.state)
          .toSorted(),
      ).toEqual(["cancelled", "cancelled", "declined"]);
      expect(yield* canSee(bob.memberId, projectA)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("only project members invite, and only creators and admins remove", () =>
    Effect.gen(function* () {
      const invitations = yield* ProjectInvitations.ProjectInvitations;
      const ada = yield* addMember("ada");
      const bob = yield* addMember("bob");
      const cy = yield* addMember("cy");
      yield* createProject(projectA, ada.memberId);

      const outsider = yield* Effect.flip(
        invitations.invite(cy.memberId, { projectId: projectA, memberId: bob.memberId }),
      );
      expect(outsider.reason).toBe("forbidden");
      const outsiderList = yield* Effect.flip(invitations.listForProject(cy.memberId, projectA));
      expect(outsiderList.reason).toBe("forbidden");

      for (const invitee of [bob, cy]) {
        const { invitation } = yield* invitations.invite(ada.memberId, {
          projectId: projectA,
          memberId: invitee.memberId,
        });
        yield* invitations.accept(invitee.memberId, invitation.invitationId);
      }

      // Any member can invite, but a non-creator cannot remove someone.
      const notCreator = yield* Effect.flip(
        invitations.removeProjectMember(bob.memberId, {
          projectId: projectA,
          memberId: cy.memberId,
        }),
      );
      expect(notCreator.reason).toBe("forbidden");

      // Leaving and removing revoke visibility.
      const afterLeave = yield* invitations.leaveProject(bob.memberId, projectA);
      expect(afterLeave.memberIds).not.toContain(bob.memberId);
      expect(yield* canSee(bob.memberId, projectA)).toBe(false);

      const afterRemove = yield* invitations.removeProjectMember(ada.memberId, {
        projectId: projectA,
        memberId: cy.memberId,
      });
      expect(afterRemove).toMatchObject({ creatorId: ada.memberId, memberIds: [ada.memberId] });
      expect(yield* canSee(cy.memberId, projectA)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("invites a new person with a pending member account and a sign-in link", () =>
    Effect.gen(function* () {
      const invitations = yield* ProjectInvitations.ProjectInvitations;
      const team = yield* TeamAccess.TeamAccess;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const ada = yield* addMember("ada");
      yield* createProject(projectA, ada.memberId);

      const { invitation, signIn } = yield* invitations.invite(ada.memberId, {
        projectId: projectA,
        newPerson: { displayName: "Grace Hopper" },
      });
      expect(signIn).toBeDefined();
      const grace = (yield* invitations.listMembers()).find(
        (member) => member.memberId === invitation.inviteeId,
      );
      expect(grace).toMatchObject({
        username: "grace-hopper",
        role: "member",
        invitedBy: ada.memberId,
        pending: true,
      });

      // Redeeming the link signs them in and ends the pending state.
      yield* auth.createBrowserSession(signIn!.credential, { deviceType: "desktop" });
      const session = yield* team.resolveSessionMember({
        subject: TeamAccess.memberSubject(invitation.inviteeId),
      });
      expect(session.memberId).toBe(invitation.inviteeId);
      const mine = yield* invitations.listMine(invitation.inviteeId);
      expect(mine.invitations.map((i) => i.invitationId)).toEqual([invitation.invitationId]);
      yield* invitations.accept(invitation.inviteeId, invitation.invitationId);
      expect(yield* canSee(invitation.inviteeId, projectA)).toBe(true);
      const roster = yield* invitations.listMembers();
      expect(roster.find((member) => member.memberId === invitation.inviteeId)?.pending).toBe(
        undefined,
      );

      // The same display name gets a fresh username.
      const second = yield* invitations.invite(ada.memberId, {
        projectId: projectA,
        newPerson: { displayName: "Grace Hopper" },
      });
      const secondMember = (yield* invitations.listMembers()).find(
        (member) => member.memberId === second.invitation.inviteeId,
      );
      expect(secondMember?.username).toBe("grace-hopper-2");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes a pending account whose link is cancelled or expires unredeemed", () =>
    Effect.gen(function* () {
      const invitations = yield* ProjectInvitations.ProjectInvitations;
      const ada = yield* addMember("ada");
      yield* createProject(projectA, ada.memberId);
      const isActive = (memberId: MemberId) =>
        invitations
          .listMembers()
          .pipe(
            Effect.map((roster) =>
              roster.some((member) => member.memberId === memberId && member.removedAt === null),
            ),
          );

      // Cancelled by the inviter.
      const cancelled = yield* invitations.invite(ada.memberId, {
        projectId: projectA,
        newPerson: { displayName: "Cancelled" },
      });
      expect(yield* isActive(cancelled.invitation.inviteeId)).toBe(true);
      yield* invitations.cancel(ada.memberId, cancelled.invitation.invitationId);
      expect(yield* isActive(cancelled.invitation.inviteeId)).toBe(false);

      // The link expires.
      const expiring = yield* invitations.invite(ada.memberId, {
        projectId: projectA,
        newPerson: { displayName: "Expiring" },
      });
      yield* TestClock.adjust(Duration.hours(25));
      expect(yield* isActive(expiring.invitation.inviteeId)).toBe(false);
      const states = (yield* invitations.listForProject(ada.memberId, projectA)).invitations.map(
        (invitation) => [invitation.inviteeId, invitation.state],
      );
      expect(states).toContainEqual([expiring.invitation.inviteeId, "expired"]);
      expect(states).toContainEqual([cancelled.invitation.inviteeId, "cancelled"]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("caps pending invitations per inviter", () =>
    Effect.gen(function* () {
      const invitations = yield* ProjectInvitations.ProjectInvitations;
      const ada = yield* addMember("ada");
      yield* createProject(projectA, ada.memberId);
      const inviteNew = (index: number) =>
        invitations.invite(ada.memberId, {
          projectId: projectA,
          newPerson: { displayName: `Person ${index}` },
        });

      for (let index = 0; index < PROJECT_INVITATION_PENDING_LIMIT; index += 1) {
        yield* inviteNew(index);
      }
      const capped = yield* Effect.flip(inviteNew(PROJECT_INVITATION_PENDING_LIMIT));
      expect(capped.reason).toBe("limit-reached");

      // Answered invitations free a slot.
      const [first] = (yield* invitations.listForProject(ada.memberId, projectA)).invitations;
      yield* invitations.cancel(ada.memberId, first!.invitationId);
      yield* inviteNew(PROJECT_INVITATION_PENDING_LIMIT + 1);
    }).pipe(Effect.provide(testLayer)),
  );
});
