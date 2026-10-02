"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateBudget = estimateBudget;
/**
 * Approximate view of how much of the subscriber's permission is used in a rolling window of `periodDuration`.
 * The wallet's periods are fixed-aligned, not rolling, so this is an estimate used to reject obviously
 * over-budget usage early. The wallet's own enforcement remains the source of truth.
 */
function estimateBudget(store, sub, now) {
    const limit = BigInt(sub.grant.periodAmount);
    const windowStart = now - sub.grant.periodDuration;
    const settled = store
        .listCharges({ subscriptionId: sub.id })
        .filter((c) => c.status === "succeeded" && c.at > windowStart)
        .reduce((acc, c) => acc + BigInt(c.amount), 0n);
    const pending = store.pendingUsage(sub.id).reduce((acc, u) => acc + BigInt(u.amount), 0n);
    const used = settled + pending;
    return { limit, settled, pending, remaining: used >= limit ? 0n : limit - used };
}
