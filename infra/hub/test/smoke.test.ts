import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { TestHub } from "./harness.ts";

let hub: TestHub;
beforeAll(async () => {
  hub = await TestHub.start();
});
afterAll(async () => {
  await hub?.dispose();
});

describe("smoke", () => {
  it("health", async () => {
    const res = await hub.fetch("/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, protocol: { min: 1, max: 1 } });
  });
  it("member", async () => {
    const alice = await hub.member("alice");
    expect(alice.welcome.account.githubLogin).toBe("alice");
  });
});
