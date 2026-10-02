import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { ChargeRecord, SubscriptionRecord, UsageRecord, WebhookEvent } from "./types";

interface Snapshot {
  subs: SubscriptionRecord[];
  charges: ChargeRecord[];
  usage: UsageRecord[];
  events: WebhookEvent[];
}

/**
 * Deliberately simple persistence: in-memory maps flushed to one JSON file with an atomic rename.
 * Fine for a single keeper process. Swap for Postgres/SQLite before running more than one instance.
 */
export class Store {
  private subs = new Map<string, SubscriptionRecord>();
  private charges: ChargeRecord[] = [];
  private usage = new Map<string, UsageRecord>();
  private events: WebhookEvent[] = [];
  private readonly db?: any;

  constructor(private readonly path?: string) {
    if (path?.startsWith("sqlite:")) {
      const databasePath = path.slice("sqlite:".length) || "./tabline.db";
      try {
        const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => any };
        this.db = new DatabaseSync(databasePath);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS tabline_state (id INTEGER PRIMARY KEY CHECK (id = 1), subs TEXT NOT NULL, charges TEXT NOT NULL, usage TEXT NOT NULL, events TEXT NOT NULL);");
        const row = this.db.prepare("SELECT subs, charges, usage, events FROM tabline_state WHERE id = 1").get() as Partial<Record<keyof Snapshot, string>> | undefined;
        if (row) {
          const snap = { subs: JSON.parse(row.subs!), charges: JSON.parse(row.charges!), usage: JSON.parse(row.usage!), events: JSON.parse(row.events!) } as Snapshot;
          snap.subs.forEach((s) => this.subs.set(s.id, s));
          this.charges = snap.charges;
          snap.usage.forEach((u) => this.usage.set(u.id, u));
          this.events = snap.events;
        }
      } catch (error) {
        throw new Error(`SQLite persistence is unavailable. Use a Node runtime with node:sqlite or configure DATA_FILE. ${(error as Error).message}`);
      }
    } else if (path && existsSync(path)) {
      const snap = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
      snap.subs.forEach((s) => this.subs.set(s.id, s));
      this.charges = snap.charges;
      snap.usage.forEach((u) => this.usage.set(u.id, u));
      this.events = snap.events;
    }
  }

  private flush() {
    const snap: Snapshot = {
      subs: [...this.subs.values()],
      charges: this.charges,
      usage: [...this.usage.values()],
      events: this.events,
    };
    if (this.db) {
      this.db.prepare("INSERT INTO tabline_state (id, subs, charges, usage, events) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET subs=excluded.subs, charges=excluded.charges, usage=excluded.usage, events=excluded.events").run(
        JSON.stringify(snap.subs), JSON.stringify(snap.charges), JSON.stringify(snap.usage), JSON.stringify(snap.events),
      );
      return;
    }
    if (!this.path) return;
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap));
    renameSync(tmp, this.path);
  }

  // ---- subscriptions
  addSub(sub: Omit<SubscriptionRecord, "id">): SubscriptionRecord {
    const rec = { ...sub, id: `sub_${randomUUID().slice(0, 12)}` };
    this.subs.set(rec.id, rec);
    this.flush();
    return rec;
  }
  getSub(id: string): SubscriptionRecord | undefined {
    return this.subs.get(id);
  }
  findSub(planId: string, subscriber: string): SubscriptionRecord | undefined {
    return [...this.subs.values()].find(
      (s) => s.planId === planId && s.subscriber.toLowerCase() === subscriber.toLowerCase() && s.status !== "cancelled" && s.status !== "expired",
    );
  }
  listSubs(filter: { subscriber?: string; planId?: string; status?: string } = {}): SubscriptionRecord[] {
    return [...this.subs.values()].filter(
      (s) =>
        (!filter.subscriber || s.subscriber.toLowerCase() === filter.subscriber.toLowerCase()) &&
        (!filter.planId || s.planId === filter.planId) &&
        (!filter.status || s.status === filter.status),
    );
  }
  updateSub(id: string, patch: Partial<SubscriptionRecord>): SubscriptionRecord {
    const cur = this.subs.get(id);
    if (!cur) throw new Error(`unknown subscription ${id}`);
    const next = { ...cur, ...patch };
    this.subs.set(id, next);
    this.flush();
    return next;
  }

  // ---- charges
  addCharge(charge: Omit<ChargeRecord, "id">): ChargeRecord {
    const rec = { ...charge, id: `chg_${randomUUID().slice(0, 12)}` };
    this.charges.push(rec);
    this.flush();
    return rec;
  }
  listCharges(filter: { subscriptionId?: string; subscriber?: string; planId?: string } = {}): ChargeRecord[] {
    return this.charges.filter(
      (c) =>
        (!filter.subscriptionId || c.subscriptionId === filter.subscriptionId) &&
        (!filter.subscriber || c.subscriber.toLowerCase() === filter.subscriber.toLowerCase()) &&
        (!filter.planId || c.planId === filter.planId),
    );
  }

  // ---- usage (metered)
  /** Idempotent on (subscriptionId, idempotencyKey). Returns the existing record on replay. */
  addUsage(u: Omit<UsageRecord, "id" | "status">): { record: UsageRecord; replay: boolean } {
    const existing = [...this.usage.values()].find(
      (x) => x.subscriptionId === u.subscriptionId && x.idempotencyKey === u.idempotencyKey,
    );
    if (existing) return { record: existing, replay: true };
    const rec: UsageRecord = { ...u, id: `use_${randomUUID().slice(0, 12)}`, status: "pending" };
    this.usage.set(rec.id, rec);
    this.flush();
    return { record: rec, replay: false };
  }
  listUsage(subscriptionId?: string): UsageRecord[] {
    return [...this.usage.values()].filter((u) => !subscriptionId || u.subscriptionId === subscriptionId);
  }
  pendingUsage(subscriptionId: string): UsageRecord[] {
    return this.listUsage(subscriptionId)
      .filter((u) => u.status === "pending")
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  }
  markUsageSettled(ids: string[], chargeId: string) {
    for (const id of ids) {
      const u = this.usage.get(id);
      if (u) this.usage.set(id, { ...u, status: "settled", chargeId });
    }
    this.flush();
  }

  // ---- events
  addEvent(e: WebhookEvent) {
    this.events.push(e);
    if (this.events.length > 1000) this.events = this.events.slice(-1000);
    this.flush();
  }
  listEvents(limit = 100): WebhookEvent[] {
    return this.events.slice(-limit).reverse();
  }
}
