import { TablineError } from "@tabline/sdk";
import type { Backend, EventView, Overview, PlanView, SubscriptionDetail, SubscriptionView, ChargeView, UsageView } from "./backend";

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const rid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const fakeTx = () => `0x${Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("")}`;
const ME = "0x8A3c5F1d2E9b47C60aB1d0E4F7a92C3B5d6E1F08";
const TOKEN = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const MERCHANT = "0x4B7e91A2c3D5f60817aE9b2C4d1F3e5A6b7C8d90";

const PLANS: Record<string, PlanView> = {
  "1": { id: "1", merchant: MERCHANT as never, payout: MERCHANT as never, token: TOKEN as never, amount: "9000000", period: 30 * DAY, kind: "fixed", active: true },
  "2": { id: "2", merchant: MERCHANT as never, payout: MERCHANT as never, token: TOKEN as never, amount: "5000000", period: 0, kind: "metered", active: true },
};

interface DemoSub extends SubscriptionView {
  charges: ChargeView[];
  usage: UsageView[];
}

/**
 * SIMULATED backend for reviewing the UI with no wallet, keeper or chain. Nothing here touches a network. Every
 * screen that uses it shows a "Simulated data" notice; it must never be presented as real activity.
 */
export class DemoBackend implements Backend {
  readonly demo = true;
  private subs: DemoSub[] = [];
  private eventsLog: EventView[] = [];
  private nextPlan = 3;

  constructor() {
    // A lived-in merchant view: one long-running subscriber with history.
    const s = this.make("1", "0x91c0a7D3e5B2f4681A0C9d7E3b5F2a4c6D8e1B37", 9_000_000n, 30 * DAY, now() - 62 * DAY);
    for (const d of [62, 32, 2]) this.charge(s, "9000000", "fixed", now() - d * DAY);
    s.onchain = { startedAt: now() - 62 * DAY, nextDueAt: now() + 28 * DAY, totalPaid: "27000000", cancelled: false };
    const late = this.make("1", "0x2f7B4c9E1a3D5806b2C7e9F1d4A6c8E0b3D5f712", 9_000_000n, 30 * DAY, now() - 40 * DAY);
    this.charge(late, "9000000", "fixed", now() - 40 * DAY);
    late.status = "past_due";
    late.failures = 3;
    late.lastError = "redemption reverted: allowance exhausted";
    this.charge(late, "9000000", "fixed", now() - 10 * DAY, "failed", "redemption reverted: allowance exhausted");
  }

  private make(planId: string, subscriber: string, limit: bigint, periodDuration: number, createdAt: number): DemoSub {
    const plan = PLANS[planId];
    const sub: DemoSub = {
      id: rid("sub"), planId, subscriber: subscriber as never, status: "active", failures: 0, nextAttemptAt: 0, createdAt,
      permission: { token: TOKEN as never, periodAmount: limit.toString(), periodDuration: plan.kind === "fixed" ? plan.period : periodDuration, expiry: now() + 365 * DAY },
      onchain: { startedAt: createdAt, nextDueAt: createdAt + plan.period, totalPaid: "0", cancelled: false },
      budget: { limit: limit.toString(), settled: "0", pending: "0", remaining: limit.toString() },
      charges: [], usage: [],
    };
    this.subs.push(sub);
    this.event("subscription.created", { subscriptionId: sub.id, planId, subscriber });
    return sub;
  }

  private charge(sub: DemoSub, amount: string, kind: "fixed" | "metered", at = now(), status: "succeeded" | "failed" = "succeeded", error?: string) {
    const c: ChargeView = { id: rid("chg"), subscriptionId: sub.id, planId: sub.planId, subscriber: sub.subscriber, amount, kind, status, txHash: status === "succeeded" ? fakeTx() : undefined, error, at };
    sub.charges.push(c);
    if (status === "succeeded" && sub.onchain) sub.onchain.totalPaid = (BigInt(sub.onchain.totalPaid) + BigInt(amount)).toString();
    this.event(status === "succeeded" ? "charge.succeeded" : "charge.failed", { subscriptionId: sub.id, amount, kind, error }, at);
    this.recompute(sub);
  }

  private event(type: string, data: Record<string, unknown>, at = now()) {
    this.eventsLog.unshift({ id: rid("evt"), type, at, data });
  }

  private recompute(sub: DemoSub) {
    const limit = BigInt(sub.permission.periodAmount);
    const start = now() - sub.permission.periodDuration;
    const settled = sub.charges.filter((c) => c.status === "succeeded" && c.at > start).reduce((a, c) => a + BigInt(c.amount), 0n);
    const pending = sub.usage.filter((u) => u.status === "pending").reduce((a, u) => a + BigInt(u.amount), 0n);
    const used = settled + pending;
    sub.budget = { limit: limit.toString(), settled: settled.toString(), pending: pending.toString(), remaining: (used >= limit ? 0n : limit - used).toString() };
  }

  /** Pretend the keeper settles pending usage a moment after it is reported. */
  private settleSoon(sub: DemoSub) {
    setTimeout(() => {
      const batch = sub.usage.filter((u) => u.status === "pending");
      if (!batch.length) return;
      const total = batch.reduce((a, u) => a + BigInt(u.amount), 0n);
      const c: ChargeView = { id: rid("chg"), subscriptionId: sub.id, planId: sub.planId, subscriber: sub.subscriber, amount: total.toString(), kind: "metered", status: "succeeded", txHash: fakeTx(), at: now() };
      sub.charges.push(c);
      batch.forEach((u) => (u.status = "settled"));
      if (sub.onchain) sub.onchain.totalPaid = (BigInt(sub.onchain.totalPaid) + total).toString();
      this.event("charge.succeeded", { subscriptionId: sub.id, amount: total.toString(), kind: "metered" });
      this.recompute(sub);
    }, 2500);
  }

  private get(id: string): DemoSub {
    const s = this.subs.find((x) => x.id === id);
    if (!s) throw new TablineError("unknown_subscription", "No such subscription.", 404);
    return s;
  }
  private strip = ({ charges: _c, usage: _u, ...rest }: DemoSub): SubscriptionView => rest;

  async connect() { return ME; }
  async connectWalletConnect() { return ME; }
  async connectedAccount() { return ME; }
  async merchantLogin() { return ME; }
  async merchantLoginWalletConnect() { return ME; }
  async merchantSession() { return ME; }
  async merchantLogout() { return undefined; }
  async plan(id: string) { const p = PLANS[id]; if (!p) throw new TablineError("unknown_plan", `Plan ${id} does not exist.`, 404); return p; }

  async subscribe(planId: string, budget?: bigint) {
    if (this.subs.some((s) => s.planId === planId && s.subscriber === ME && s.status === "active")) {
      throw new TablineError("already_subscribed", "This account already has a live subscription to this plan.", 409);
    }
    const plan = PLANS[planId];
    const limit = budget ?? BigInt(plan.amount);
    const sub = this.make(planId, ME, limit, 30 * DAY, now());
    if (plan.kind === "fixed") this.charge(sub, plan.amount, "fixed");
    return this.strip(sub);
  }
  async subscriptions(subscriber: string) { return this.subs.filter((s) => s.subscriber.toLowerCase() === subscriber.toLowerCase()).map(this.strip); }
  async subscription(id: string): Promise<SubscriptionDetail> { const s = this.get(id); return { ...this.strip(s), charges: [...s.charges], usage: [...s.usage] }; }
  async cancel(id: string, _onchain?: boolean) { const s = this.get(id); s.status = "cancelled"; this.event("subscription.cancelled", { subscriptionId: id, by: "subscriber_signature" }); return this.strip(s); }

  async allSubscriptions() { return this.subs.map(this.strip); }
  async allCharges() { return this.subs.flatMap((s) => s.charges).sort((a, b) => b.at - a.at); }
  async overview(): Promise<Overview> {
    const live = this.subs.filter((s) => s.status === "active" || s.status === "past_due");
    const charges = this.subs.flatMap((s) => s.charges);
    const t = now();
    return {
      activeSubscriptions: this.subs.filter((s) => s.status === "active").length,
      pastDue: this.subs.filter((s) => s.status === "past_due").length,
      cancelled: this.subs.filter((s) => s.status === "cancelled").length,
      monthlyRecurring: live.filter((s) => PLANS[s.planId].kind === "fixed").reduce((a, s) => a + BigInt(PLANS[s.planId].amount), 0n).toString(),
      collected30d: charges.filter((c) => c.status === "succeeded" && c.at > t - 30 * DAY).reduce((a, c) => a + BigInt(c.amount), 0n).toString(),
      failed30d: charges.filter((c) => c.status === "failed" && c.at > t - 30 * DAY).length,
      pendingUsage: this.subs.flatMap((s) => s.usage).filter((u) => u.status === "pending").reduce((a, u) => a + BigInt(u.amount), 0n).toString(),
    };
  }
  async events() { return this.eventsLog.slice(0, 50); }
  async runBilling() { /* nothing is due in the simulation */ }
  async retry(id: string) { const s = this.get(id); this.charge(s, PLANS[s.planId].amount, "fixed"); s.status = "active"; s.failures = 0; s.lastError = undefined; }
  async cancelAsMerchant(id: string) { await this.cancel(id, false); }

  async postUsage(a: { subscriptionId: string; amount: bigint; idempotencyKey: string; label?: string }) {
    const s = this.get(a.subscriptionId);
    if (s.status !== "active") throw new TablineError("not_active", `Subscription is ${s.status}.`, 409);
    this.recompute(s);
    if (a.amount > BigInt(s.budget.remaining)) {
      throw new TablineError("budget_exceeded", "This would exceed the subscriber's spending limit.", 402, { remaining: s.budget.remaining, limit: s.budget.limit });
    }
    s.usage.push({ id: rid("use"), subscriptionId: s.id, amount: a.amount.toString(), units: "1", label: a.label, status: "pending", at: now() });
    this.recompute(s);
    this.settleSoon(s);
    return { remaining: s.budget.remaining };
  }
  async createPlan(a: { amount: bigint; periodSeconds: number; kind: "fixed" | "metered"; payout: string; token: string }) {
    const id = String(this.nextPlan++);
    PLANS[id] = { id, merchant: MERCHANT as never, payout: a.payout as never, token: a.token as never, amount: a.amount.toString(), period: a.kind === "fixed" ? a.periodSeconds : 0, kind: a.kind, active: true };
    return id;
  }
}
