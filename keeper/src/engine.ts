import type { Address, Hex } from "viem";
import type { Chain } from "./chain";
import { fixedChargeKey, meteredChargeKey } from "./chain";
import { PartialChargeError, type Redeemer } from "./redeemers";
import type { Store } from "./store";
import type { Plan, SubscriptionRecord } from "./types";
import type { Webhooks } from "./webhooks";

export interface EngineDeps {
  chain: Chain;
  store: Store;
  redeemer: Redeemer;
  webhooks: Webhooks;
}

export interface EngineOptions {
  now?: () => number;
  /** Backoff (seconds) after each consecutive failure. Exhausting the list moves the subscription to past_due. */
  retryScheduleSec?: number[];
  /** Fraction (0-1) of a metered plan's per-settlement cap that must be pending before it is auto-settled. */
  meteredSettleFraction?: number;
  /** Regardless of the fraction, settle once the oldest pending usage item is at least this old. */
  meteredMaxAgeSec?: number;
}

export interface CycleReport {
  attempted: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  expired: number;
}

const DEFAULT_RETRY_SCHEDULE = [60, 300, 1800, 7200, 43200];
const DEFAULT_METERED_MAX_AGE = 24 * 3600;

/**
 * Runs one polling loop over every non-terminal subscription: skips what isn't due, charges what is, and updates
 * status/retry state from the result. All timing (now, backoff) goes through `opts.now` so it is fully
 * deterministic under a test chain's virtual clock -- never reads Date.now() directly in the charging path.
 */
export class Engine {
  private readonly now: () => number;
  private readonly retrySchedule: number[];
  private readonly meteredFraction: number;
  private readonly meteredMaxAge: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly deps: EngineDeps,
    opts: EngineOptions = {},
  ) {
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.retrySchedule = opts.retryScheduleSec ?? DEFAULT_RETRY_SCHEDULE;
    this.meteredFraction = opts.meteredSettleFraction ?? 1;
    this.meteredMaxAge = opts.meteredMaxAgeSec ?? DEFAULT_METERED_MAX_AGE;
  }

  start(intervalMs: number) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runCycle().catch((e) => console.error("engine cycle error:", e));
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One full pass over every active/past_due subscription. Never throws -- a bad sub is logged and skipped. */
  async runCycle(): Promise<CycleReport> {
    if (this.running) return { attempted: 0, succeeded: 0, failed: 0, cancelled: 0, expired: 0 };
    this.running = true;
    try {
      return await this.doCycle();
    } finally {
      this.running = false;
    }
  }

  private async doCycle(): Promise<CycleReport> {
    const { store } = this.deps;
    const report: CycleReport = { attempted: 0, succeeded: 0, failed: 0, cancelled: 0, expired: 0 };
    const now = this.now();
    const planCache = new Map<string, Plan>();

    const subs = store
      .listSubs()
      .filter((s) => s.status === "active" || s.status === "past_due");

    for (const sub of subs) {
      try {
        let plan = planCache.get(sub.planId);
        if (!plan) {
          plan = await this.deps.chain.readPlan(BigInt(sub.planId));
          planCache.set(sub.planId, plan);
        }
        if (!plan.active) continue;

        if (sub.grant.expiry && sub.grant.expiry <= now) {
          store.updateSub(sub.id, { status: "expired" });
          report.expired++;
          await this.deps.webhooks.emit("subscription.expired", { subscriptionId: sub.id, subscriber: sub.subscriber, planId: sub.planId });
          continue;
        }

        const onchain = await this.deps.chain.readSubscription(BigInt(sub.planId), sub.subscriber);
        if (onchain.cancelled) {
          store.updateSub(sub.id, { status: "cancelled" });
          report.cancelled++;
          await this.deps.webhooks.emit("subscription.cancelled", { subscriptionId: sub.id, subscriber: sub.subscriber, planId: sub.planId, by: "onchain" });
          continue;
        }

        if (sub.nextAttemptAt > now) continue;

        if (plan.kind === "fixed") {
          await this.tickFixed(plan, sub, onchain.nextDueAt, now, report);
        } else {
          await this.tickMetered(plan, sub, now, report);
        }
      } catch (e) {
        console.error(`engine: unexpected error on subscription ${sub.id}:`, (e as Error).message);
      }
    }
    return report;
  }

  private async tickFixed(plan: Plan, sub: SubscriptionRecord, nextDueAt: number, now: number, report: CycleReport) {
    const due = await this.deps.chain.isDue(BigInt(sub.planId), sub.subscriber);
    if (!due) return;

    const chargeKey = fixedChargeKey(nextDueAt || now);
    if (await this.deps.chain.isSettled(BigInt(sub.planId), sub.subscriber, chargeKey)) return; // already paid; local state will catch up on the next read

    report.attempted++;
    await this.attempt(plan, sub, chargeKey, plan.amount, "fixed", now, report);
  }

  private async tickMetered(plan: Plan, sub: SubscriptionRecord, now: number, report: CycleReport) {
    // Loop: keep forming and settling batches while the threshold is met and the sub is still healthy.
    for (;;) {
      const pending = this.deps.store.pendingUsage(sub.id);
      if (pending.length === 0) return;

      let total = 0n;
      const batchIds: string[] = [];
      for (const u of pending) {
        const amt = BigInt(u.amount);
        if (total + amt > plan.amount) break;
        total += amt;
        batchIds.push(u.id);
      }
      if (batchIds.length === 0) {
        console.error(`engine: usage item on subscription ${sub.id} exceeds the plan cap; needs manual handling`);
        return;
      }

      const requiredMin = (plan.amount * BigInt(Math.round(this.meteredFraction * 1_000_000))) / 1_000_000n;
      const oldestAge = now - pending[0].at;
      const thresholdMet = total >= requiredMin || oldestAge >= this.meteredMaxAge;
      if (!thresholdMet) return;

      const chargeKey = meteredChargeKey(batchIds);
      if (await this.deps.chain.isSettled(BigInt(sub.planId), sub.subscriber, chargeKey)) {
        this.deps.store.markUsageSettled(batchIds, "reconciled-onchain");
        continue; // this batch was already paid (e.g. after a crash); reconcile and keep draining the rest
      }

      report.attempted++;
      const chargeId = await this.attempt(plan, sub, chargeKey, total, "metered", now, report);
      if (chargeId) {
        this.deps.store.markUsageSettled(batchIds, chargeId);
      } else {
        return; // charge failed: stop for this subscription this tick, retry/backoff already recorded
      }
    }
  }

  /** Executes one charge and updates all bookkeeping. Returns the new charge id on success, undefined on failure. */
  private async attempt(
    plan: Plan,
    sub: SubscriptionRecord,
    chargeKey: Hex,
    amount: bigint,
    kind: "fixed" | "metered",
    now: number,
    report: CycleReport,
  ): Promise<string | undefined> {
    const { store, webhooks, redeemer } = this.deps;
    try {
      const txHash = await redeemer.charge({ planId: BigInt(sub.planId), subscriber: sub.subscriber, chargeKey, amount, plan, grant: sub.grant });
      const charge = store.addCharge({ subscriptionId: sub.id, planId: sub.planId, subscriber: sub.subscriber, chargeKey, amount: amount.toString(), kind, status: "succeeded", txHash, at: now });
      store.updateSub(sub.id, { status: "active", failures: 0, nextAttemptAt: 0, lastError: undefined });
      report.succeeded++;
      await webhooks.emit("charge.succeeded", { chargeId: charge.id, subscriptionId: sub.id, subscriber: sub.subscriber, planId: sub.planId, amount: amount.toString(), txHash });
      return charge.id;
    } catch (e) {
      report.failed++;
      const err = e as Error;
      store.addCharge({ subscriptionId: sub.id, planId: sub.planId, subscriber: sub.subscriber, chargeKey, amount: amount.toString(), kind, status: "failed", error: err.message, at: now });

      if (err instanceof PartialChargeError) {
        // Funds may have already moved once via the redeem step; never auto-retry (could double-pull). A human
        // must reconcile the tx before this subscription bills again.
        store.updateSub(sub.id, { status: "needs_review", lastError: err.message });
        await webhooks.emit("subscription.needs_review", { subscriptionId: sub.id, subscriber: sub.subscriber, planId: sub.planId, redeemTx: err.redeemTx, reason: err.reason });
        return undefined;
      }

      const failures = sub.failures + 1;
      if (failures >= this.retrySchedule.length) {
        if (sub.status !== "past_due") {
          store.updateSub(sub.id, { status: "past_due", failures, lastError: err.message });
          await webhooks.emit("subscription.past_due", { subscriptionId: sub.id, subscriber: sub.subscriber, planId: sub.planId, failures });
        } else {
          store.updateSub(sub.id, { failures, lastError: err.message });
        }
      } else {
        const backoff = this.retrySchedule[failures - 1];
        store.updateSub(sub.id, { failures, nextAttemptAt: now + backoff, lastError: err.message });
        await webhooks.emit("charge.failed", { subscriptionId: sub.id, subscriber: sub.subscriber, planId: sub.planId, attempt: failures, retryInSeconds: backoff, error: err.message });
      }
      return undefined;
    }
  }
}
