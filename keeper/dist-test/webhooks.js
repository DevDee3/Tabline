"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Webhooks = void 0;
exports.verifySignature = verifySignature;
const node_crypto_1 = require("node:crypto");
const stringify = (v) => JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
function sign(secret, body) {
    return (0, node_crypto_1.createHmac)("sha256", secret).update(body).digest("hex");
}
/** What a merchant's own receiving server calls to check `x-tabline-signature`. */
function verifySignature(secret, header, body) {
    if (!header)
        return false;
    try {
        const expected = Buffer.from(sign(secret, body), "hex");
        const got = Buffer.from(header, "hex");
        return expected.length === got.length && (0, node_crypto_1.timingSafeEqual)(expected, got);
    }
    catch {
        return false;
    }
}
/**
 * Emits Tabline lifecycle events: always recorded to the store (so /v1/events works even with no webhook
 * configured), and best-effort POSTed to `url` with an HMAC signature if `secret` is set. Delivery failures are
 * logged and swallowed -- a merchant's downed endpoint must never interrupt billing.
 */
class Webhooks {
    store;
    opts;
    constructor(store, opts = {}) {
        this.store = store;
        this.opts = opts;
    }
    async emit(type, data) {
        const event = {
            id: `evt_${(0, node_crypto_1.randomUUID)().slice(0, 12)}`,
            type,
            at: this.opts.now?.() ?? Math.floor(Date.now() / 1000),
            data,
        };
        this.store.addEvent(event);
        if (this.opts.url) {
            const body = stringify(event);
            const headers = { "content-type": "application/json" };
            if (this.opts.secret)
                headers["x-tabline-signature"] = sign(this.opts.secret, body);
            const fetchFn = this.opts.fetchImpl ?? fetch;
            const attempts = 1 + (this.opts.retries ?? 2);
            for (let i = 0; i < attempts; i++) {
                try {
                    await fetchFn(this.opts.url, { method: "POST", headers, body });
                    break;
                }
                catch (e) {
                    if (i === attempts - 1)
                        console.error(`webhook delivery failed after ${attempts} attempts: ${e.message}`);
                }
            }
        }
        return event;
    }
}
exports.Webhooks = Webhooks;
