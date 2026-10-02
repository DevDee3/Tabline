import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { foundry } from "viem/chains";
import { cancelMessage, createApi } from "../src/api";
import { Engine } from "../src/engine";
import { Store } from "../src/store";
import { verifySignature, Webhooks } from "../src/webhooks";
import { acct, deployWorld, DirectPayerRedeemer, startAnvil, USDC, type World } from "./helpers/harness";

let stop: () => void;
let url: string;
let w: World;
let store: Store;
let server: Server;
let base: string;
let sessionCookie = "";
let planFixed: bigint;
let planMetered: bigint;

const alice = acct("alice").address;
const PERIOD = 30 * 24 * 3600;

beforeAll(async () => {
  const a = await startAnvil(18546);
  stop = a.stop;
  url = a.url;
});
afterAll(() => stop?.());

beforeEach(async () => {
  server?.close();
  w = await deployWorld(url);
  store = new Store();
  const redeemer = new DirectPayerRedeemer(w, { [alice.toLowerCase()]: "alice" });
  const webhooks = new Webhooks(store, { now: w.clock });
  const engine = new Engine({ chain: w.chain, store, redeemer, webhooks }, { now: w.clock, meteredSettleFraction: 0 });
  server = createApi({ chain: w.chain, store, engine, webhooks, publicClient: w.publicClient as never, keeperAddress: redeemer.keeperAddress, chainId: foundry.id, now: w.clock });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sessionCookie = await login();
  planFixed = await w.createPlan({ amount: USDC("10"), period: PERIOD, kind: 0 });
  planMetered = await w.createPlan({ amount: USDC("5"), period: 0, kind: 1 });
});
afterAll(() => server?.close());

const login = async () => {
  const wallet = acct("merchant");
  const nonce = await fetch(`${base}/v1/auth/nonce?address=${wallet.address}`).then((r) => r.json() as Promise<{ message: string }>);
  const signature = await wallet.signMessage({ message: nonce.message });
  const response = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: wallet.address, signature }) });
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
};

const call = async (path: string, init: { method?: string; body?: unknown; auth?: boolean; session?: boolean } = {}) => {
  const res = await fetch(base + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(init.session === false ? {} : { cookie: sessionCookie }) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};

/** Shape of a real wallet_requestExecutionPermissions response entry (bigints arrive as hex strings). */
const permission = (over: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) => ({
  chainId: `0x${foundry.id.toString(16)}`,
  from: alice,
  to: acct("keeper").address,
  permission: { type: "erc20-token-periodic", data: { tokenAddress: w.usdc, periodAmount: `0x${USDC("100").toString(16)}`, periodDuration: 86400, ...dataOver }, isAdjustmentAllowed: true },
  rules: [{ type: "expiry", data: { timestamp: w.clock() + 365 * 86400 } }],
  context: "0xdeadbeef",
  dependencies: [],
  delegationManager: "0x0000000000000000000000000000000000000dad",
  ...over,
});

const subscribe = (planId: bigint, grant: unknown) => call("/v1/subscriptions", { body: { planId: planId.toString(), subscriber: alice, grant: [grant] } });

describe("config and plans", () => {
  it("publishes the keeper address the wallet must grant to", async () => {
    const r = await call("/v1/config");
    expect(r.body.keeperAddress).toBe(acct("keeper").address);
    expect(r.body.chainId).toBe(foundry.id);
  });

  it("serves plan details and 404s unknown plans", async () => {
    const ok = await call(`/v1/plans/${planFixed}`);
    expect(ok.body).toMatchObject({ kind: "fixed", amount: USDC("10").toString(), period: PERIOD, active: true });
    expect((await call("/v1/plans/999")).status).toBe(404);
  });
});

describe("subscribing", () => {
  it("accepts a valid permission and never leaks its context", async () => {
    const r = await subscribe(planFixed, permission());
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "active", planId: planFixed.toString() });
    expect(JSON.stringify(r.body)).not.toContain("deadbeef");
    expect(r.body.permission.periodAmount).toBe(USDC("100").toString());
    expect(store.listEvents().map((e) => e.type)).toContain("subscription.created");
  });

  it.each([
    ["wrong delegate", () => permission({ to: acct("bob").address }), "wrong_delegate"],
    ["wrong grantor", () => permission({ from: acct("bob").address }), "wrong_subscriber"],
    ["no expiry", () => permission({ rules: [] }), "no_expiry"],
    ["expiry too soon", () => permission({ rules: [{ type: "expiry", data: { timestamp: w.clock() + 60 } }] }), "expiry_too_soon"],
    ["wrong token", () => permission({}, { tokenAddress: "0x000000000000000000000000000000000000dEaD" }), "wrong_token"],
    ["limit too low", () => permission({}, { periodAmount: `0x${USDC("5").toString(16)}` }), "limit_too_low"],
    ["period too long", () => permission({}, { periodDuration: PERIOD + 1 }), "period_too_long"],
    ["wrong permission type", () => permission({ permission: { type: "native-token-stream", data: {} } }), "unsupported_permission"],
  ])("rejects %s", async (_name, makeGrant, code) => {
    const r = await subscribe(planFixed, makeGrant());
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(code);
  });

  it("rejects a second live subscription to the same plan", async () => {
    expect((await subscribe(planFixed, permission())).status).toBe(201);
    const again = await subscribe(planFixed, permission());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_subscribed");
  });

  it("lists subscriptions without merchant authentication", async () => {
    expect((await call("/v1/subscriptions", { session: false })).status).toBe(401);
    expect((await call("/v1/subscriptions")).status).toBe(200);
  });
});

describe("billing through the API", () => {
  it("charges a new subscriber and exposes the charge", async () => {
    await subscribe(planFixed, permission());
    expect((await call("/v1/engine/run", { method: "POST", auth: true })).body).toMatchObject({ succeeded: 1 });

    const charges = await call(`/v1/charges?subscriber=${alice}`);
    expect(charges.body.data).toHaveLength(1);
    expect(charges.body.data[0]).toMatchObject({ status: "succeeded", amount: USDC("10").toString() });

    const subs = await call(`/v1/subscriptions?subscriber=${alice}`);
    expect(subs.body.data[0].onchain.totalPaid).toBe(USDC("10").toString());

    const overview = await call("/v1/merchant/overview", { auth: true });
    expect(overview.body).toMatchObject({ activeSubscriptions: 1, collected30d: USDC("10").toString(), failed30d: 0 });
    expect(BigInt(overview.body.monthlyRecurring)).toBe(USDC("10"));
  });

  it("allows merchant endpoints without an API key", async () => {
    for (const p of ["/v1/merchant/overview", "/v1/events"]) expect((await call(p, { session: false })).status).toBe(401);
    expect((await call("/v1/merchant/overview")).status).toBe(200);
    expect((await call("/v1/engine/run", { method: "POST", session: false })).status).toBe(401);
  });
});

describe("metered usage", () => {
  let subId: string;
  beforeEach(async () => {
    const r = await subscribe(planMetered, permission({}, { periodAmount: `0x${USDC("10").toString(16)}` }));
    expect(r.status).toBe(201);
    subId = r.body.id;
  });
  const usage = (amount: bigint, key: string, auth = true) => call("/v1/usage", { auth, body: { subscriptionId: subId, amount: amount.toString(), idempotencyKey: key, units: "1", label: "api call" } });

  it("records usage idempotently", async () => {
    const first = await usage(USDC("1"), "k1");
    expect(first.status).toBe(201);
    const replay = await usage(USDC("1"), "k1");
    expect(replay.status).toBe(200);
    expect(replay.body.replay).toBe(true);
    expect(store.pendingUsage(subId)).toHaveLength(1);
  });

  it("rejects usage above the per-settlement cap and above the permission budget", async () => {
    const over = await usage(USDC("6"), "big");
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("over_cap");

    for (let i = 0; i < 2; i++) expect((await usage(USDC("5"), `b${i}`)).status).toBe(201); // budget 10 used up
    const blocked = await usage(USDC("1"), "one-too-many");
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toMatchObject({ code: "budget_exceeded", remaining: "0" });
  });

  it("settles pending usage on the next cycle", async () => {
    await usage(USDC("2"), "a");
    await usage(USDC("3"), "b");
    expect((await call("/v1/engine/run", { method: "POST" })).body).toMatchObject({ succeeded: 1 });
    expect((await w.chain.readSubscription(planMetered, alice)).totalPaid).toBe(USDC("5"));
  });
});

describe("cancelling", () => {
  it("accepts a valid subscriber signature and stops billing", async () => {
    const sub = (await subscribe(planFixed, permission())).body;
    const signature = await acct("alice").signMessage({ message: cancelMessage(sub.id) });
    const r = await call(`/v1/subscriptions/${sub.id}/cancel`, { body: { signature } });
    expect(r.body.status).toBe("cancelled");
    expect((await call("/v1/engine/run", { method: "POST", auth: true })).body).toMatchObject({ attempted: 0 });
  });

  it("allows cancellation without API-key authentication", async () => {
    const sub = (await subscribe(planFixed, permission())).body;
    const forged = await acct("bob").signMessage({ message: cancelMessage(sub.id) });
    expect((await call(`/v1/subscriptions/${sub.id}/cancel`, { body: { signature: forged } })).body.status).toBe("cancelled");
  });
});

describe("webhooks", () => {
  it("signs deliveries so merchants can verify them", async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: init.body as string });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const hooks = new Webhooks(new Store(), { url: "https://merchant.example/hook", secret: "shh", fetchImpl });
    await hooks.emit("charge.succeeded", { amount: "1" });

    expect(seen).toHaveLength(1);
    expect(verifySignature("shh", seen[0].headers["x-tabline-signature"], seen[0].body)).toBe(true);
    expect(verifySignature("wrong", seen[0].headers["x-tabline-signature"], seen[0].body)).toBe(false);
    expect(verifySignature("shh", seen[0].headers["x-tabline-signature"], seen[0].body + " ")).toBe(false);
  });

  it("retries failed deliveries but never throws into billing", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const hooks = new Webhooks(new Store(), { url: "https://merchant.example/hook", fetchImpl, retries: 1 });
    await expect(hooks.emit("charge.failed", {})).resolves.toBeTruthy();
    expect(calls).toBe(2);
  });
});
