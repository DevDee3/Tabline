"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Store = void 0;
const node_fs_1 = require("node:fs");
const node_crypto_1 = require("node:crypto");
/**
 * Deliberately simple persistence: in-memory maps flushed to one JSON file with an atomic rename.
 * Fine for a single keeper process. Swap for Postgres/SQLite before running more than one instance.
 */
class Store {
    path;
    subs = new Map();
    charges = [];
    usage = new Map();
    events = [];
    constructor(path) {
        this.path = path;
        if (path && (0, node_fs_1.existsSync)(path)) {
            const snap = JSON.parse((0, node_fs_1.readFileSync)(path, "utf8"));
            snap.subs.forEach((s) => this.subs.set(s.id, s));
            this.charges = snap.charges;
            snap.usage.forEach((u) => this.usage.set(u.id, u));
            this.events = snap.events;
        }
    }
    flush() {
        if (!this.path)
            return;
        const snap = {
            subs: [...this.subs.values()],
            charges: this.charges,
            usage: [...this.usage.values()],
            events: this.events,
        };
        const tmp = `${this.path}.tmp`;
        (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(snap));
        (0, node_fs_1.renameSync)(tmp, this.path);
    }
    // ---- subscriptions
    addSub(sub) {
        const rec = { ...sub, id: `sub_${(0, node_crypto_1.randomUUID)().slice(0, 12)}` };
        this.subs.set(rec.id, rec);
        this.flush();
        return rec;
    }
    getSub(id) {
        return this.subs.get(id);
    }
    findSub(planId, subscriber) {
        return [...this.subs.values()].find((s) => s.planId === planId && s.subscriber.toLowerCase() === subscriber.toLowerCase() && s.status !== "cancelled" && s.status !== "expired");
    }
    listSubs(filter = {}) {
        return [...this.subs.values()].filter((s) => (!filter.subscriber || s.subscriber.toLowerCase() === filter.subscriber.toLowerCase()) &&
            (!filter.planId || s.planId === filter.planId) &&
            (!filter.status || s.status === filter.status));
    }
    updateSub(id, patch) {
        const cur = this.subs.get(id);
        if (!cur)
            throw new Error(`unknown subscription ${id}`);
        const next = { ...cur, ...patch };
        this.subs.set(id, next);
        this.flush();
        return next;
    }
    // ---- charges
    addCharge(charge) {
        const rec = { ...charge, id: `chg_${(0, node_crypto_1.randomUUID)().slice(0, 12)}` };
        this.charges.push(rec);
        this.flush();
        return rec;
    }
    listCharges(filter = {}) {
        return this.charges.filter((c) => (!filter.subscriptionId || c.subscriptionId === filter.subscriptionId) &&
            (!filter.subscriber || c.subscriber.toLowerCase() === filter.subscriber.toLowerCase()) &&
            (!filter.planId || c.planId === filter.planId));
    }
    // ---- usage (metered)
    /** Idempotent on (subscriptionId, idempotencyKey). Returns the existing record on replay. */
    addUsage(u) {
        const existing = [...this.usage.values()].find((x) => x.subscriptionId === u.subscriptionId && x.idempotencyKey === u.idempotencyKey);
        if (existing)
            return { record: existing, replay: true };
        const rec = { ...u, id: `use_${(0, node_crypto_1.randomUUID)().slice(0, 12)}`, status: "pending" };
        this.usage.set(rec.id, rec);
        this.flush();
        return { record: rec, replay: false };
    }
    listUsage(subscriptionId) {
        return [...this.usage.values()].filter((u) => !subscriptionId || u.subscriptionId === subscriptionId);
    }
    pendingUsage(subscriptionId) {
        return this.listUsage(subscriptionId)
            .filter((u) => u.status === "pending")
            .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    }
    markUsageSettled(ids, chargeId) {
        for (const id of ids) {
            const u = this.usage.get(id);
            if (u)
                this.usage.set(id, { ...u, status: "settled", chargeId });
        }
        this.flush();
    }
    // ---- events
    addEvent(e) {
        this.events.push(e);
        if (this.events.length > 1000)
            this.events = this.events.slice(-1000);
        this.flush();
    }
    listEvents(limit = 100) {
        return this.events.slice(-limit).reverse();
    }
}
exports.Store = Store;
