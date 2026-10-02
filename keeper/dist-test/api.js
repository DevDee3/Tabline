"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cancelMessage = void 0;
exports.createApi = createApi;
const node_http_1 = require("node:http");
const viem_1 = require("viem");
const budget_1 = require("./budget");
const grant_1 = require("./grant");
const cancelMessage = (subscriptionId) => `Tabline: cancel ${subscriptionId}`;
exports.cancelMessage = cancelMessage;
const json = (res, status, body, cors, req) => {
    const allowOrigin = typeof cors === "function" ? cors(req?.headers.origin) : cors;
    res.writeHead(status, {
        "content-type": "application/json",
        "access-control-allow-origin": allowOrigin,
        "access-control-allow-headers": "authorization, content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "600",
        vary: "Origin",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
    });
    res.end(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
};
async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > 1_000_000)
            throw new grant_1.ApiError(413, "too_large", "request body too large");
        chunks.push(c);
    }
    if (chunks.length === 0)
        return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        throw new grant_1.ApiError(400, "bad_json", "request body is not valid JSON");
    }
}
const planJson = (id, p) => ({
    id,
    merchant: p.merchant,
    payout: p.payout,
    token: p.token,
    amount: p.amount.toString(),
    period: p.period,
    kind: p.kind,
    active: p.active,
});
function createApi(deps) {
    const { chain, store, engine, webhooks, publicClient } = deps;
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    // Keep local development convenient while avoiding an accidental public API when the
    // deployment forgets to configure CORS_ORIGIN. Set CORS_ORIGIN explicitly for embeds.
    const configuredOrigins = (deps.corsOrigin?.trim() || "http://localhost:5173")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
    const localOrigin = (origin) => !!origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const cors = (origin) => {
        if (configuredOrigins.includes("*"))
            return "*";
        if (configuredOrigins.some(localOrigin) && localOrigin(origin))
            return origin;
        return origin && configuredOrigins.includes(origin) ? origin : configuredOrigins[0];
    };
    const RATE_WINDOW_MS = 60_000;
    const RATE_LIMIT = 120;
    const clients = new Map();
    const checkRateLimit = (req) => {
        const key = req.socket.remoteAddress ?? "unknown";
        const nowMs = Date.now();
        const current = clients.get(key);
        const bucket = !current || nowMs - current.startedAt >= RATE_WINDOW_MS ? { startedAt: nowMs, count: 0 } : current;
        bucket.count += 1;
        clients.set(key, bucket);
        // Avoid retaining inactive client addresses forever. This is deliberately process-local;
        // use a shared limiter before running multiple keeper instances.
        if (clients.size > 10_000) {
            for (const [address, value] of clients) {
                if (nowMs - value.startedAt >= RATE_WINDOW_MS)
                    clients.delete(address);
            }
        }
        if (bucket.count > RATE_LIMIT)
            throw new grant_1.ApiError(429, "rate_limited", "too many requests; try again shortly");
    };
    const requireMerchant = (req) => {
        const h = req.headers.authorization ?? "";
        if (h !== `Bearer ${deps.merchantApiKey}`)
            throw new grant_1.ApiError(401, "unauthorized", "merchant API key required");
    };
    const isMerchant = (req) => (req.headers.authorization ?? "") === `Bearer ${deps.merchantApiKey}`;
    const planCache = async (planId) => {
        if (!/^\d+$/.test(planId))
            throw new grant_1.ApiError(400, "bad_plan", "plan id must be a number");
        try {
            return await chain.readPlan(BigInt(planId));
        }
        catch (error) {
            if (error instanceof Error && error.message === `plan ${planId} does not exist`) {
                throw new grant_1.ApiError(404, "unknown_plan", `plan ${planId} does not exist`);
            }
            throw new grant_1.ApiError(503, "chain_unavailable", "could not read the plan from the configured blockchain RPC");
        }
    };
    /** Subscription as the public API shows it. Never includes the permission context. */
    const view = async (sub) => {
        const onchain = await chain.readSubscription(BigInt(sub.planId), sub.subscriber).catch(() => undefined);
        const budget = (0, budget_1.estimateBudget)(store, sub, now());
        return {
            id: sub.id,
            planId: sub.planId,
            subscriber: sub.subscriber,
            status: sub.status,
            failures: sub.failures,
            lastError: sub.lastError,
            nextAttemptAt: sub.nextAttemptAt,
            createdAt: sub.createdAt,
            permission: {
                token: sub.grant.tokenAddress,
                periodAmount: sub.grant.periodAmount,
                periodDuration: sub.grant.periodDuration,
                expiry: sub.grant.expiry,
            },
            onchain: onchain && { startedAt: onchain.startedAt, nextDueAt: onchain.nextDueAt, totalPaid: onchain.totalPaid.toString(), cancelled: onchain.cancelled },
            budget: { limit: budget.limit.toString(), settled: budget.settled.toString(), pending: budget.pending.toString(), remaining: budget.remaining.toString() },
        };
    };
    async function route(req, res) {
        const url = new URL(req.url ?? "/", "http://x");
        const path = url.pathname.replace(/\/+$/, "") || "/";
        const method = req.method ?? "GET";
        const q = url.searchParams;
        if (method === "OPTIONS")
            return json(res, 204, {}, cors, req);
        if (path !== "/health")
            checkRateLimit(req);
        if (method === "GET" && path === "/health") {
            return json(res, 200, { ok: true, chainId: deps.chainId, keeper: deps.keeperAddress, tabline: chain.tabline }, cors, req);
        }
        if (method === "GET" && path === "/ready") {
            const rpcChainId = await publicClient.getChainId().catch(() => undefined);
            if (rpcChainId !== deps.chainId) {
                return json(res, 503, { ok: false, error: { code: "rpc_unavailable", message: "configured blockchain RPC is unavailable" } }, cors, req);
            }
            return json(res, 200, { ok: true, chainId: rpcChainId, tabline: chain.tabline }, cors, req);
        }
        if (method === "GET" && path === "/v1/config") {
            return json(res, 200, { chainId: deps.chainId, keeperAddress: deps.keeperAddress, tabline: chain.tabline }, cors, req);
        }
        let m = path.match(/^\/v1\/plans\/(\d+)$/);
        if (method === "GET" && m)
            return json(res, 200, planJson(m[1], await planCache(m[1])), cors, req);
        if (method === "POST" && path === "/v1/subscriptions") {
            const body = await readBody(req);
            if (!(0, viem_1.isAddress)(body.subscriber ?? ""))
                throw new grant_1.ApiError(400, "bad_subscriber", "subscriber must be an address");
            const subscriber = (0, viem_1.getAddress)(body.subscriber);
            const planId = String(body.planId ?? "");
            const plan = await planCache(planId);
            if (!plan.active)
                throw new grant_1.ApiError(409, "plan_inactive", "this plan is not accepting subscribers");
            if (store.findSub(planId, subscriber))
                throw new grant_1.ApiError(409, "already_subscribed", "this account already has a live subscription to this plan");
            const onchain = await chain.readSubscription(BigInt(planId), subscriber);
            if (onchain.cancelled)
                throw new grant_1.ApiError(409, "cancelled_onchain", "this account cancelled the plan on-chain; resume it first");
            const grant = (0, grant_1.parseGrant)(body.grant, { subscriber, plan, keeper: deps.keeperAddress, chainId: deps.chainId, now: now() });
            const sub = store.addSub({ planId, subscriber, chainId: deps.chainId, grant, status: "active", failures: 0, nextAttemptAt: 0, createdAt: now() });
            await webhooks.emit("subscription.created", { subscriptionId: sub.id, planId, subscriber });
            return json(res, 201, await view(sub), cors, req);
        }
        if (method === "GET" && path === "/v1/subscriptions") {
            const subscriber = q.get("subscriber");
            if (!subscriber && !isMerchant(req))
                throw new grant_1.ApiError(401, "unauthorized", "pass ?subscriber=0x... or a merchant API key");
            if (subscriber && !(0, viem_1.isAddress)(subscriber))
                throw new grant_1.ApiError(400, "bad_subscriber", "subscriber must be an address");
            const subs = store.listSubs({ subscriber: subscriber ?? undefined, planId: q.get("planId") ?? undefined, status: q.get("status") ?? undefined });
            return json(res, 200, { data: await Promise.all(subs.map(view)) }, cors, req);
        }
        m = path.match(/^\/v1\/subscriptions\/([\w-]+)$/);
        if (method === "GET" && m) {
            const sub = store.getSub(m[1]);
            if (!sub)
                throw new grant_1.ApiError(404, "unknown_subscription", "no such subscription");
            return json(res, 200, { ...(await view(sub)), charges: store.listCharges({ subscriptionId: sub.id }), usage: store.listUsage(sub.id) }, cors, req);
        }
        m = path.match(/^\/v1\/subscriptions\/([\w-]+)\/cancel$/);
        if (method === "POST" && m) {
            const sub = store.getSub(m[1]);
            if (!sub)
                throw new grant_1.ApiError(404, "unknown_subscription", "no such subscription");
            let by = "merchant";
            if (!isMerchant(req)) {
                const body = await readBody(req);
                const ok = typeof body.signature === "string" &&
                    (await publicClient.verifyMessage({ address: sub.subscriber, message: (0, exports.cancelMessage)(sub.id), signature: body.signature }).catch(() => false));
                if (!ok)
                    throw new grant_1.ApiError(401, "bad_signature", "sign the cancel message with the subscribing account");
                by = "subscriber_signature";
            }
            if (sub.status === "cancelled")
                return json(res, 200, await view(sub), cors, req);
            const next = store.updateSub(sub.id, { status: "cancelled" });
            await webhooks.emit("subscription.cancelled", { subscriptionId: sub.id, planId: sub.planId, subscriber: sub.subscriber, by });
            return json(res, 200, await view(next), cors, req);
        }
        m = path.match(/^\/v1\/subscriptions\/([\w-]+)\/retry$/);
        if (method === "POST" && m) {
            requireMerchant(req);
            const sub = store.getSub(m[1]);
            if (!sub)
                throw new grant_1.ApiError(404, "unknown_subscription", "no such subscription");
            store.updateSub(sub.id, { nextAttemptAt: 0 });
            const report = await engine.runCycle();
            return json(res, 200, { report, subscription: await view(store.getSub(sub.id)) }, cors, req);
        }
        if (method === "POST" && path === "/v1/usage") {
            requireMerchant(req);
            const body = await readBody(req);
            const sub = store.getSub(String(body.subscriptionId ?? ""));
            if (!sub)
                throw new grant_1.ApiError(404, "unknown_subscription", "no such subscription");
            if (sub.status !== "active" && sub.status !== "past_due")
                throw new grant_1.ApiError(409, "not_active", `subscription is ${sub.status}`);
            const plan = await planCache(sub.planId);
            if (plan.kind !== "metered")
                throw new grant_1.ApiError(409, "not_metered", "usage can only be reported on metered plans");
            let amount;
            try {
                amount = BigInt(body.amount);
            }
            catch {
                throw new grant_1.ApiError(400, "bad_amount", "amount must be an integer string in token base units");
            }
            if (amount <= 0n)
                throw new grant_1.ApiError(400, "bad_amount", "amount must be positive");
            if (amount > plan.amount)
                throw new grant_1.ApiError(400, "over_cap", "a single usage item cannot exceed the plan's per-settlement cap", { cap: plan.amount.toString() });
            const key = String(body.idempotencyKey ?? "");
            if (!key)
                throw new grant_1.ApiError(400, "bad_key", "idempotencyKey is required");
            const existing = store.listUsage(sub.id).find((u) => u.idempotencyKey === key);
            if (!existing) {
                const budget = (0, budget_1.estimateBudget)(store, sub, now());
                if (amount > budget.remaining) {
                    throw new grant_1.ApiError(402, "budget_exceeded", "this would exceed the subscriber's permission limit", { remaining: budget.remaining.toString(), limit: budget.limit.toString() });
                }
            }
            const { record, replay } = store.addUsage({ subscriptionId: sub.id, idempotencyKey: key, amount: amount.toString(), units: String(body.units ?? "1"), label: body.label ? String(body.label) : undefined, at: now() });
            return json(res, replay ? 200 : 201, { usage: record, replay, budget: (({ limit, settled, pending, remaining }) => ({ limit, settled, pending, remaining }))((0, budget_1.estimateBudget)(store, sub, now())) }, cors, req);
        }
        if (method === "GET" && path === "/v1/charges") {
            const subscriber = q.get("subscriber");
            const subscriptionId = q.get("subscriptionId");
            if (!subscriber && !subscriptionId && !isMerchant(req))
                throw new grant_1.ApiError(401, "unauthorized", "filter by subscriber or subscriptionId, or use a merchant API key");
            const data = store.listCharges({ subscriber: subscriber ?? undefined, subscriptionId: subscriptionId ?? undefined }).slice(-200).reverse();
            return json(res, 200, { data }, cors, req);
        }
        if (method === "GET" && path === "/v1/merchant/overview") {
            requireMerchant(req);
            const subs = store.listSubs();
            const live = subs.filter((s) => s.status === "active" || s.status === "past_due");
            const t = now();
            const charges = store.listCharges();
            const ok30 = charges.filter((c) => c.status === "succeeded" && c.at > t - 30 * 86400);
            const plans = new Map();
            let mrr = 0n;
            for (const s of live) {
                if (!plans.has(s.planId))
                    plans.set(s.planId, await chain.readPlan(BigInt(s.planId)));
                const p = plans.get(s.planId);
                if (p.kind === "fixed")
                    mrr += (p.amount * BigInt(30 * 86400)) / BigInt(p.period);
            }
            return json(res, 200, {
                activeSubscriptions: subs.filter((s) => s.status === "active").length,
                pastDue: subs.filter((s) => s.status === "past_due").length,
                cancelled: subs.filter((s) => s.status === "cancelled").length,
                monthlyRecurring: mrr.toString(),
                collected30d: ok30.reduce((a, c) => a + BigInt(c.amount), 0n).toString(),
                failed30d: charges.filter((c) => c.status === "failed" && c.at > t - 30 * 86400).length,
                pendingUsage: store.listUsage().filter((u) => u.status === "pending").reduce((a, u) => a + BigInt(u.amount), 0n).toString(),
            }, cors, req);
        }
        if (method === "GET" && path === "/v1/events") {
            requireMerchant(req);
            return json(res, 200, { data: store.listEvents(Number(q.get("limit") ?? 100)) }, cors, req);
        }
        if (method === "POST" && path === "/v1/engine/run") {
            requireMerchant(req);
            return json(res, 200, await engine.runCycle(), cors, req);
        }
        throw new grant_1.ApiError(404, "not_found", `no route for ${method} ${path}`);
    }
    return (0, node_http_1.createServer)((req, res) => {
        route(req, res).catch((e) => {
            if (e instanceof grant_1.ApiError)
                return json(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } }, cors, req);
            console.error("unhandled:", e);
            json(res, 500, { error: { code: "internal", message: "internal error" } }, cors, req);
        });
    });
}
