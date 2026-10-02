import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";
import type { WebhookEvent, WebhookEventType } from "./types";

export interface WebhooksOptions {
  url?: string;
  secret?: string;
  now?: () => number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Extra delivery attempts after the first. Default 2 (3 attempts total). */
  retries?: number;
}

const stringify = (v: unknown) => JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** What a merchant's own receiving server calls to check `x-tabline-signature`. */
export function verifySignature(secret: string, header: string, body: string): boolean {
  if (!header) return false;
  try {
    const expected = Buffer.from(sign(secret, body), "hex");
    const got = Buffer.from(header, "hex");
    return expected.length === got.length && timingSafeEqual(expected, got);
  } catch {
    return false;
  }
}

/**
 * Emits Tabline lifecycle events: always recorded to the store (so /v1/events works even with no webhook
 * configured), and best-effort POSTed to `url` with an HMAC signature if `secret` is set. Delivery failures are
 * logged and swallowed -- a merchant's downed endpoint must never interrupt billing.
 */
export class Webhooks {
  constructor(
    private readonly store: Store,
    private readonly opts: WebhooksOptions = {},
  ) {}

  async emit(type: WebhookEventType, data: Record<string, unknown>): Promise<WebhookEvent> {
    const event: WebhookEvent = {
      id: `evt_${randomUUID().slice(0, 12)}`,
      type,
      at: this.opts.now?.() ?? Math.floor(Date.now() / 1000),
      data,
    };
    this.store.addEvent(event);

    if (this.opts.url) {
      const body = stringify(event);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.secret) headers["x-tabline-signature"] = sign(this.opts.secret, body);
      const fetchFn = this.opts.fetchImpl ?? fetch;
      const attempts = 1 + (this.opts.retries ?? 2);
      for (let i = 0; i < attempts; i++) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);
          let response: Response;
          try {
            response = await fetchFn(this.opts.url, { method: "POST", headers, body, signal: controller.signal });
          } finally {
            clearTimeout(timeout);
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          break;
        } catch (e) {
          if (i === attempts - 1) console.error(`webhook delivery failed after ${attempts} attempts: ${(e as Error).message}`);
        }
      }
    }
    return event;
  }
}
