import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthStandardClientScopes,
  OWNER_MEMBER_ID,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TeamAccess from "./TeamAccess.ts";

const testLayer = TeamAccess.layer.pipe(
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-team-access-test-" })),
);

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

it.layer(NodeServices.layer)("TeamAccess", (it) => {
  it.effect("treats every non-member session as the implicit owner admin", () =>
    Effect.gen(function* () {
      const team = yield* TeamAccess.TeamAccess;
      for (const subject of ["administrative-bootstrap", "one-time-token", "browser", "member:"]) {
        const member = yield* team.resolveSessionMember({ subject });
        expect(member.memberId).toBe(OWNER_MEMBER_ID);
        expect(member.role).toBe("admin");
      }
      expect(yield* team.isProjectMember(OWNER_MEMBER_ID, projectA)).toBe(true);
      expect(yield* team.projectVisibility(OWNER_MEMBER_ID)).toEqual({ all: true });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("adds members with unique usernames and refuses to remove the owner", () =>
    Effect.gen(function* () {
      const team = yield* TeamAccess.TeamAccess;
      const ada = yield* team.addMember({ username: "ada", displayName: "Ada", role: "member" });
      const duplicate = yield* Effect.flip(
        team.addMember({ username: "ada", displayName: "Other Ada", role: "member" }),
      );
      const ownerRemoval = yield* Effect.flip(team.removeMember(OWNER_MEMBER_ID));

      expect(duplicate._tag).toBe("TeamUsernameTakenError");
      expect(ownerRemoval._tag).toBe("TeamOwnerImmutableError");
      expect((yield* team.listMembers()).map((member) => member.username)).toEqual([
        "owner",
        "ada",
      ]);

      // A removed member's username can be reused.
      yield* team.removeMember(ada.memberId);
      const readded = yield* team.addMember({ username: "ada", displayName: "Ada", role: "admin" });
      expect(readded.memberId).not.toBe(ada.memberId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("mints member credentials whose sessions act as the member", () =>
    Effect.gen(function* () {
      const team = yield* TeamAccess.TeamAccess;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const grace = yield* team.addMember({
        username: "grace",
        displayName: "Grace",
        role: "member",
      });
      const admin = yield* team.addMember({ username: "root", displayName: "Root", role: "admin" });

      const credential = yield* team.issueMemberCredential(grace.memberId);
      const links = yield* auth.listPairingLinks();
      const graceLink = links.find((link) => link.id === credential.id);
      expect(graceLink?.subject).toBe(TeamAccess.memberSubject(grace.memberId));
      expect(graceLink?.scopes).toEqual(AuthStandardClientScopes);

      const adminCredential = yield* team.issueMemberCredential(admin.memberId);
      const adminLink = (yield* auth.listPairingLinks()).find(
        (link) => link.id === adminCredential.id,
      );
      expect(adminLink?.scopes).toEqual(AuthAdministrativeScopes);

      const session = yield* auth.createBrowserSession(credential.credential, {
        deviceType: "desktop",
      });
      const resolved = yield* team.resolveSessionMember({
        subject: TeamAccess.memberSubject(grace.memberId),
      });
      expect(session.response.authenticated).toBe(true);
      expect(resolved.memberId).toBe(grace.memberId);
      expect(yield* Effect.flip(team.issueMemberCredential(OWNER_MEMBER_ID))).toHaveProperty(
        "_tag",
        "TeamOwnerImmutableError",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("revokes a member's sessions and credentials on removal", () =>
    Effect.gen(function* () {
      const team = yield* TeamAccess.TeamAccess;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const member = yield* team.addMember({
        username: "linus",
        displayName: "Linus",
        role: "member",
      });
      const redeemed = yield* team.issueMemberCredential(member.memberId);
      yield* auth.createBrowserSession(redeemed.credential, { deviceType: "desktop" });
      const pending = yield* team.issueMemberCredential(member.memberId);

      const revoked = yield* team.revokeMemberAccess(member.memberId);
      expect(revoked).toEqual({ revokedSessions: 1, revokedCredentials: 1 });
      expect((yield* auth.listPairingLinks()).some((link) => link.id === pending.id)).toBe(false);

      // Access can be minted again, then removal revokes it for good.
      const again = yield* team.issueMemberCredential(member.memberId);
      yield* auth.createBrowserSession(again.credential, { deviceType: "desktop" });
      yield* team.removeMember(member.memberId);
      const subject = TeamAccess.memberSubject(member.memberId);
      expect((yield* auth.listSessions()).some((session) => session.subject === subject)).toBe(
        false,
      );
      expect((yield* Effect.flip(team.resolveSessionMember({ subject })))._tag).toBe(
        "TeamMemberNotFoundError",
      );
      expect((yield* Effect.flip(team.issueMemberCredential(member.memberId)))._tag).toBe(
        "TeamMemberNotFoundError",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("limits a member's visibility to the projects they belong to", () =>
    Effect.gen(function* () {
      const team = yield* TeamAccess.TeamAccess;
      const sql = yield* SqlClient.SqlClient;
      const member = yield* team.addMember({
        username: "barbara",
        displayName: "Barbara",
        role: "member",
      });

      expect(yield* team.isProjectMember(member.memberId, projectA)).toBe(false);
      const shared = yield* team.addProjectMember({
        projectId: projectA,
        memberId: member.memberId,
      });
      expect(shared.memberIds).toEqual([member.memberId]);
      expect(yield* team.isProjectMember(member.memberId, projectA)).toBe(true);
      expect(yield* team.isProjectMember(member.memberId, projectB)).toBe(false);

      const visibility = yield* team.projectVisibility(member.memberId);
      const snapshot = TeamAccess.filterByProjectVisibility(
        {
          projects: [{ id: projectA }, { id: projectB }],
          threads: [
            { id: "thread-a", projectId: projectA },
            { id: "thread-b", projectId: projectB },
          ],
        },
        visibility,
      );
      expect(snapshot.projects.map((project) => project.id)).toEqual([projectA]);
      expect(snapshot.threads.map((thread) => thread.id)).toEqual(["thread-a"]);

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at, created_by
        )
        VALUES (
          'thread-b', ${projectB}, 'B', '{}', 'full-access', 'default',
          NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL,
          ${member.memberId}
        )
      `;
      expect(yield* team.canSeeThread(member.memberId, ThreadId.make("thread-b"))).toBe(false);
      expect(yield* team.isThreadCreator(member.memberId, ThreadId.make("thread-b"))).toBe(true);
      expect(yield* team.isThreadCreator(OWNER_MEMBER_ID, ThreadId.make("thread-b"))).toBe(false);

      yield* team.removeProjectMember({ projectId: projectA, memberId: member.memberId });
      expect(yield* team.isProjectMember(member.memberId, projectA)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );
});
