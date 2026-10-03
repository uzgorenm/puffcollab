import * as NodeCrypto from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { TestHub } from "./harness.ts";

let hub: TestHub;
beforeAll(async () => {
  hub = await TestHub.start();
});
afterAll(async () => {
  await hub?.dispose();
});

const pkce = () => {
  const verifier = NodeCrypto.randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
  };
};

const startLink = async (challenge: string) =>
  (await (
    await hub.json("/v1/link/requests", {
      environmentLabel: "Mehmet's MacBook",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    })
  ).json()) as {
    requestId: string;
    userCode: string;
    verificationUrl: string;
    intervalSeconds: number;
  };

/** The hub allows one token poll per interval; tests skip the wait by clearing the stamp. */
const allowPoll = (requestId: string) =>
  hub
    .db()
    .then((db) =>
      db
        .prepare("UPDATE link_requests SET last_polled_at_ms = NULL WHERE request_id = ?")
        .bind(requestId)
        .run(),
    );

describe("GitHub sign-in", () => {
  it("creates the account, sets a hardened session cookie, and claims pending invitations", async () => {
    const owner = await hub.member("octo-owner");
    const linked = await hub.linkProject(owner.link.credential, "github.com/acme/widgets");
    expect(linked.body.created).toBe(true);
    const projectId = linked.body.project.projectId;
    await owner.client.nextOfType("team.snapshot");
    const invited = await owner.client.request({
      type: "invitation.create",
      projectId,
      githubLogin: "New-Comer",
    });
    expect(invited.type).toBe("ack");
    const pending = await owner.client.nextOfType("team.invitations");
    expect(pending.invitations[0]).toMatchObject({ inviteeLogin: "New-Comer", inviteeId: null });

    hub.users.set("new-comer", { id: 4242, login: "new-comer", name: "New Comer" });
    const start = await hub.fetch("/v1/auth/github/start?returnTo=%2Flink%3Fcode%3DABCD-EFGH", {
      redirect: "manual",
    });
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      "http://hub.test/v1/auth/github/callback",
    );
    const stateCookie = start.headers.getSetCookie()[0]!.split(";")[0]!;

    const callback = await hub.fetch(
      `/v1/auth/github/callback?code=new-comer&state=${authorize.searchParams.get("state")}`,
      { redirect: "manual", headers: { Cookie: stateCookie } },
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/link?code=ABCD-EFGH");
    const session = callback.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith("puffcollab_hub_session="))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).not.toMatch(/Secure/i); // http hub; https hubs add Secure

    const me = await hub.fetch("/v1/auth/session", { headers: { Cookie: session.split(";")[0]! } });
    const body = (await me.json()) as {
      account: { accountId: string; githubLogin: string; displayName: string };
    };
    expect(body.account).toMatchObject({ githubLogin: "new-comer", displayName: "New Comer" });

    const claimed = await owner.client.nextOfType(
      "team.invitations",
      (m) => m.invitations[0]?.inviteeId !== null,
    );
    expect(claimed.invitations[0].inviteeId).toBe(body.account.accountId);
  });

  it("rejects a callback whose state does not match the signed cookie", async () => {
    const start = await hub.fetch("/v1/auth/github/start", { redirect: "manual" });
    const stateCookie = start.headers.getSetCookie()[0]!.split(";")[0]!;
    const callback = await hub.fetch("/v1/auth/github/callback?code=x&state=forged", {
      redirect: "manual",
      headers: { Cookie: stateCookie },
    });
    expect(callback.status).toBe(400);
    const noCookie = await hub.fetch(
      `/v1/auth/github/callback?code=x&state=${new URL(start.headers.get("location")!).searchParams.get("state")}`,
      { redirect: "manual" },
    );
    expect(noCookie.status).toBe(400);
  });

  it("keeps returnTo on the hub", async () => {
    const protocolRelative = await hub.fetch("/v1/auth/github/start?returnTo=%2F%2Fevil.example", {
      redirect: "manual",
    });
    expect(protocolRelative.status).toBe(400);
    expect((await hub.signIn("returner", "/\\evil.example")).location).toBe("/link");
    expect((await hub.signIn("returner", "/link?code=WDJB-MJHT")).location).toBe(
      "/link?code=WDJB-MJHT",
    );
  });

  it("refuses cross-origin writes with a session cookie", async () => {
    const { cookie } = await hub.signIn("csrf-target");
    const response = await hub.json(
      "/v1/link/decision",
      { userCode: "BCDF-GHJK", decision: "approve" },
      { headers: { Cookie: cookie, Origin: "https://evil.example" } },
    );
    expect(response.status).toBe(401);
  });

  it("signs out", async () => {
    const { cookie } = await hub.signIn("leaver");
    expect(
      (await hub.fetch("/v1/auth/sign-out", { method: "POST", headers: { Cookie: cookie } }))
        .status,
    ).toBe(204);
    expect((await hub.fetch("/v1/auth/session", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("environment linking", () => {
  it("runs start → approve → token, and returns the credential exactly once", async () => {
    const { cookie } = await hub.signIn("linker");
    const { verifier, challenge } = pkce();
    const started = await startLink(challenge);
    expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(started.verificationUrl).toBe(`http://hub.test/link?code=${started.userCode}`);

    const pending = await hub.json("/v1/link/token", {
      requestId: started.requestId,
      codeVerifier: verifier,
    });
    expect(await pending.json()).toEqual({ status: "pending" });
    const tooFast = await hub.json("/v1/link/token", {
      requestId: started.requestId,
      codeVerifier: verifier,
    });
    expect(tooFast.status).toBe(429);

    const described = await hub.fetch(`/v1/link/requests/${started.userCode}`, {
      headers: { Cookie: cookie },
    });
    expect(await described.json()).toMatchObject({ environmentLabel: "Mehmet's MacBook" });
    const page = await hub.fetch(`/link?code=${started.userCode}`, { headers: { Cookie: cookie } });
    expect(await page.text()).toContain("@linker");

    const approve = await hub.json(
      "/v1/link/decision",
      { userCode: started.userCode, decision: "approve" },
      { headers: { Cookie: cookie } },
    );
    expect(approve.status).toBe(204);

    const wrongVerifier = await hub.json("/v1/link/token", {
      requestId: started.requestId,
      codeVerifier: pkce().verifier,
    });
    expect(wrongVerifier.status).toBe(400);

    await allowPoll(started.requestId);
    const linked = (await (
      await hub.json("/v1/link/token", { requestId: started.requestId, codeVerifier: verifier })
    ).json()) as {
      status: string;
      credential: string;
      linkId: string;
      account: { githubLogin: string };
    };
    expect(linked).toMatchObject({ status: "linked", account: { githubLogin: "linker" } });
    expect(linked.credential).toMatch(/^phc_/);

    await allowPoll(started.requestId);
    const again = await hub.json("/v1/link/token", {
      requestId: started.requestId,
      codeVerifier: verifier,
    });
    expect(again.status).toBe(404);

    const info = await hub.fetch("/v1/environment", {
      headers: { Authorization: `Bearer ${linked.credential}` },
    });
    expect(await info.json()).toMatchObject({
      link: { linkId: linked.linkId, environmentLabel: "Mehmet's MacBook" },
      account: { githubLogin: "linker" },
    });
    const links = (await (
      await hub.fetch("/v1/account/links", { headers: { Cookie: cookie } })
    ).json()) as {
      links: Array<{ linkId: string }>;
    };
    expect(links.links.map((link) => link.linkId)).toEqual([linked.linkId]);
  });

  it("reports denied and expired requests", async () => {
    const { cookie } = await hub.signIn("denier");
    const denied = pkce();
    const deniedStart = await startLink(denied.challenge);
    await hub.json(
      "/v1/link/decision",
      { userCode: deniedStart.userCode, decision: "deny" },
      { headers: { Cookie: cookie } },
    );
    expect(
      await (
        await hub.json("/v1/link/token", {
          requestId: deniedStart.requestId,
          codeVerifier: denied.verifier,
        })
      ).json(),
    ).toEqual({ status: "denied" });

    const expired = pkce();
    const expiredStart = await startLink(expired.challenge);
    const db = await hub.db();
    await db
      .prepare("UPDATE link_requests SET expires_at_ms = 0 WHERE request_id = ?")
      .bind(expiredStart.requestId)
      .run();
    expect(
      await (
        await hub.json("/v1/link/token", {
          requestId: expiredStart.requestId,
          codeVerifier: expired.verifier,
        })
      ).json(),
    ).toEqual({ status: "expired" });
    const late = await hub.json(
      "/v1/link/decision",
      { userCode: expiredStart.userCode, decision: "approve" },
      { headers: { Cookie: cookie } },
    );
    expect(late.status).toBe(404);
  });

  it("revoking a link closes its socket with 4403 and refuses the credential", async () => {
    const member = await hub.member("revoker");
    const response = await hub.fetch(`/v1/account/links/${member.linkId}`, {
      method: "DELETE",
      headers: { Cookie: member.cookie },
    });
    expect(response.status).toBe(204);
    expect((await member.client.waitClosed()).code).toBe(4403);
    const reconnect = await hub.connect(member.link.credential);
    expect((await reconnect.waitClosed()).code).toBe(4403);
    const info = await hub.fetch("/v1/environment", {
      headers: { Authorization: `Bearer ${member.link.credential}` },
    });
    expect(info.status).toBe(401);
  });

  it("closes unknown credentials with 4401", async () => {
    const client = await hub.connect("phc_not-a-real-credential");
    expect((await client.waitClosed()).code).toBe(4401);
  });
});

describe("project link", () => {
  it("returns the caller's project for a key, creates one otherwise, and never reveals another team's", async () => {
    const alice = await hub.member("pl-alice");
    const bob = await hub.member("pl-bob");
    const created = await hub.linkProject(alice.link.credential, "github.com/acme/shared");
    expect(created.body).toMatchObject({ created: true, alternatives: [] });
    expect(created.body.project.createdBy).toBe(alice.accountId);
    const again = await hub.linkProject(alice.link.credential, "github.com/acme/shared");
    expect(again.body).toMatchObject({
      created: false,
      project: { projectId: created.body.project.projectId },
    });

    const bobs = await hub.linkProject(bob.link.credential, "github.com/acme/shared");
    expect(bobs.body.created).toBe(true);
    expect(bobs.body.project.projectId).not.toBe(created.body.project.projectId);

    const intrude = await hub.linkProject(
      bob.link.credential,
      "github.com/acme/shared",
      created.body.project.projectId,
    );
    expect(intrude.status).toBe(403);
  });
});
