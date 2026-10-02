import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { foundry } from "viem/chains";
import { tablineAbi } from "../src/abi";
import { Engine } from "../src/engine";
import { meteredChargeKey } from "../src/chain";
import { Store } from "../src/store";
import { Webhooks } from "../src/webhooks";
import { acct, deployWorld, DirectPayerRedeemer, startAnvil, USDC, type World } from "./helpers/harness";

let stop: () => void;
let url: string;
let w: World;
let store: Store;
let redeemer: DirectPayerRedeemer;
let engine: Engine;

const alice = acct("alice").address;
const bob = acct("bob").address;
const PRICE = USDC("10");
const PERIOD = 30 * 24 * 3600;

beforeAll(async () => {
  const a = await startAnvil(18545);
  stop = a.stop;
  url = a.url;
});
afterAll(() => stop?.());

beforeEach(async () => {
  w = await deployWorld(url);
  store = new Store();
  redeemer = new DirectPayerRedeemer(w, { [alice.toLowerCase()]: "alice", [bob.toLowerCase()]: "bob" });
  engine = new Engine(
    { chain: w.chain, store, redeemer, webhooks: new Webhooks(store, { now: w.clock }) },
    { now: w.clock, meteredSettleFraction: 0, retryScheduleSec: [60, 600, 3600] },
  );
});

const subscribe = (planId: bigint, who: `0x${string}`, grant = {}) =>
  store.addSub({ planId: planId.toString(), subscriber: who, chainId: foundry.id, grant: w.grantFor(who, grant), status: "active", failures: 0, nextAttemptAt: 0, createdAt: w.clock() });

const eventTypes = () => store.listEvents().map((e) => e.type);

describe("fixed plans", () => {
  it("charges on the first cycle, records it, and settles on-chain", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    subscribe(plan, alice);

    const report = await engine.runCycle();
    expect(report).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });

    const onchain = await w.chain.readSubscription(plan, alice);
    expect(onchain.totalPaid).toBe(PRICE);
    expect(await w.balance(acct("merchant").address)).toBe(PRICE);
    const charges = store.listCharges({ subscriber: alice });
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ status: "succeeded", kind: "fixed", amount: PRICE.toString() });
    expect(charges[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(eventTypes()).toContain("charge.succeeded");
  });

  it("does not charge again before the period elapses, then charges when due", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    subscribe(plan, alice);
    await engine.runCycle();

    expect((await engine.runCycle()).attempted).toBe(0);
    expect(redeemer.calls).toBe(1);

    await w.warp(PERIOD + 5);
    expect((await engine.runCycle()).succeeded).toBe(1);
    expect((await w.chain.readSubscription(plan, alice)).totalPaid).toBe(PRICE * 2n);
  });

  it("bills exactly once after a long outage instead of back-billing", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    subscribe(plan, alice);
    await engine.runCycle();
    await w.warp(5 * PERIOD);

    expect((await engine.runCycle()).succeeded).toBe(1);
    expect((await engine.runCycle()).attempted).toBe(0);
    expect((await w.chain.readSubscription(plan, alice)).totalPaid).toBe(PRICE * 2n);
  });

  it("handles subscribers independently", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    subscribe(plan, alice);
    subscribe(plan, bob);
    expect((await engine.runCycle()).succeeded).toBe(2);
    expect(await w.balance(acct("merchant").address)).toBe(PRICE * 2n);
  });

  it("records a failure, waits out the backoff, then recovers", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    const sub = subscribe(plan, alice);
    redeemer.failWith = "redemption reverted: allowance exhausted";

    expect((await engine.runCycle()).failed).toBe(1);
    let cur = store.getSub(sub.id)!;
    expect(cur.failures).toBe(1);
    expect(cur.lastError).toContain("allowance exhausted");
    expect(cur.nextAttemptAt).toBeGreaterThan(w.clock());
    expect(store.listCharges()[0]).toMatchObject({ status: "failed" });

    // Inside the backoff window: no retry.
    redeemer.failWith = undefined;
    expect((await engine.runCycle()).attempted).toBe(0);

    await w.warp(61);
    expect((await engine.runCycle()).succeeded).toBe(1);
    cur = store.getSub(sub.id)!;
    expect(cur).toMatchObject({ failures: 0, status: "active" });
  });

  it("flags past_due after repeated failures (once) and recovers to active", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    const sub = subscribe(plan, alice);
    redeemer.failWith = "boom";

    for (let i = 0; i < 3; i++) {
      await engine.runCycle();
      await w.warp(4000);
    }
    expect(store.getSub(sub.id)!.status).toBe("past_due");
    expect(eventTypes().filter((t) => t === "subscription.past_due")).toHaveLength(1);

    redeemer.failWith = undefined;
    await engine.runCycle();
    expect(store.getSub(sub.id)).toMatchObject({ status: "active", failures: 0 });
  });

  it("surfaces the wallet's period limit as a failed charge", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    const sub = subscribe(plan, alice, { periodAmount: USDC("5").toString() });
    await engine.runCycle();
    expect(store.getSub(sub.id)!.lastError).toContain("exceeds period allowance");
    expect(await w.balance(acct("merchant").address)).toBe(0n);
  });

  it("stops when the subscriber cancels on-chain", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    const sub = subscribe(plan, alice);
    const h = await w.wallet("alice").writeContract({ address: w.tabline, abi: tablineAbi, functionName: "cancel", args: [plan], account: acct("alice"), chain: foundry });
    await w.publicClient.waitForTransactionReceipt({ hash: h });

    const report = await engine.runCycle();
    expect(report).toMatchObject({ cancelled: 1, attempted: 0 });
    expect(store.getSub(sub.id)!.status).toBe("cancelled");
    expect(eventTypes()).toContain("subscription.cancelled");
  });

  it("expires subscriptions whose permission has lapsed", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    const sub = subscribe(plan, alice, { expiry: w.clock() - 1 });
    const report = await engine.runCycle();
    expect(report).toMatchObject({ expired: 1, attempted: 0 });
    expect(store.getSub(sub.id)!.status).toBe("expired");
  });

  it("does nothing for an inactive plan", async () => {
    const plan = await w.createPlan({ amount: PRICE, period: PERIOD, kind: 0 });
    subscribe(plan, alice);
    const h = await w.wallet("merchant").writeContract({ address: w.tabline, abi: tablineAbi, functionName: "setActive", args: [plan, false], account: acct("merchant"), chain: foundry });
    await w.publicClient.waitForTransactionReceipt({ hash: h });
    expect((await engine.runCycle()).attempted).toBe(0);
  });
});

describe("metered plans", () => {
  const CAP = USDC("5");

  it("batches usage under the cap and settles it all", async () => {
    const plan = await w.createPlan({ amount: CAP, period: 0, kind: 1 });
    const sub = subscribe(plan, alice);
    // 7 x 1.00 = 7.00 total with a 5.00 cap per settlement -> two settlements (5.00 + 2.00).
    for (let i = 0; i < 7; i++) store.addUsage({ subscriptionId: sub.id, idempotencyKey: `k${i}`, amount: USDC("1").toString(), units: "1", at: w.clock() + i });

    const report = await engine.runCycle();
    expect(report).toMatchObject({ attempted: 2, succeeded: 2 });
    expect(store.pendingUsage(sub.id)).toHaveLength(0);
    expect((await w.chain.readSubscription(plan, alice)).totalPaid).toBe(USDC("7"));
    expect(store.listCharges().map((c) => c.amount).sort()).toEqual([USDC("2").toString(), USDC("5").toString()].sort());
  });

  it("waits for a full cap unless the oldest usage gets stale", async () => {
    const plan = await w.createPlan({ amount: CAP, period: 0, kind: 1 });
    const sub = subscribe(plan, alice);
    const lazy = new Engine(
      { chain: w.chain, store, redeemer, webhooks: new Webhooks(store, { now: w.clock }) },
      { now: w.clock, meteredSettleFraction: 1, meteredMaxAgeSec: 3600 },
    );
    store.addUsage({ subscriptionId: sub.id, idempotencyKey: "a", amount: USDC("1").toString(), units: "1", at: w.clock() });

    expect((await lazy.runCycle()).attempted).toBe(0);
    await w.warp(3601);
    expect((await lazy.runCycle()).succeeded).toBe(1);
    expect((await w.chain.readSubscription(plan, alice)).totalPaid).toBe(USDC("1"));
  });

  it("replaying a usage idempotency key never double counts", () => {
    const sub = subscribe(1n, alice);
    const first = store.addUsage({ subscriptionId: sub.id, idempotencyKey: "same", amount: "100", units: "1", at: 1 });
    const second = store.addUsage({ subscriptionId: sub.id, idempotencyKey: "same", amount: "100", units: "1", at: 2 });
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(store.pendingUsage(sub.id)).toHaveLength(1);
  });

  it("reconciles a batch already settled on-chain without paying twice", async () => {
    const plan = await w.createPlan({ amount: CAP, period: 0, kind: 1 });
    const sub = subscribe(plan, alice);
    const { record } = store.addUsage({ subscriptionId: sub.id, idempotencyKey: "u1", amount: USDC("2").toString(), units: "1", at: w.clock() });

    // Simulate a crash: the charge fully settled on-chain but the keeper never recorded it.
    const key = meteredChargeKey([record.id]);
    await redeemer.charge({ planId: plan, subscriber: alice, chargeKey: key, amount: USDC("2"), plan: await w.chain.readPlan(plan), grant: sub.grant });
    const before = await w.balance(acct("merchant").address);

    const report = await engine.runCycle();
    expect(report.attempted).toBe(0);
    expect(store.pendingUsage(sub.id)).toHaveLength(0);
    expect(await w.balance(acct("merchant").address)).toBe(before);
  });
});
