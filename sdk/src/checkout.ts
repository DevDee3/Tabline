import { Tabline, TablineError, type SubscriptionView } from "./client";
import { formatUsdc, parseUsdc } from "./format";

/**
 * <tabline-checkout api-url="https://billing.example.com" plan-id="1" label="Subscribe with Tabline"
 *                   budget-usdc="20"></tabline-checkout>
 *
 * Fires `tabline:subscribed` (detail: SubscriptionView) or `tabline:error` (detail: { code, message }).
 * `budget-usdc` is the max the subscriber allows per period; omit it to use the plan amount.
 */
export class TablineCheckout extends HTMLElement {
  static observedAttributes = ["label"];
  private button!: HTMLButtonElement;
  private note!: HTMLParagraphElement;

  connectedCallback() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { display: inline-block; font-family: system-ui, sans-serif; }
        button { font: inherit; font-weight: 600; padding: .7rem 1.1rem; border-radius: 6px; border: 0;
                 background: #2b44ff; color: #fff; cursor: pointer; }
        button:hover:not(:disabled) { background: #1f33d6; }
        button:focus-visible { outline: 3px solid #101b2d; outline-offset: 2px; }
        button:disabled { opacity: .6; cursor: progress; }
        p { margin: .5rem 0 0; font-size: .85rem; max-width: 28ch; color: #101b2d; }
        p[data-kind="error"] { color: #a4301b; }
      </style>
      <button type="button"></button>
      <p role="status" aria-live="polite"></p>`;
    this.button = root.querySelector("button")!;
    this.note = root.querySelector("p")!;
    this.button.textContent = this.getAttribute("label") ?? "Subscribe with Tabline";
    this.button.addEventListener("click", () => void this.run());
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (name === "label" && this.button) this.button.textContent = value ?? "Subscribe with Tabline";
  }

  private say(text: string, kind: "info" | "error" = "info") {
    this.note.textContent = text;
    this.note.dataset.kind = kind;
  }

  private async run() {
    const apiUrl = this.getAttribute("api-url");
    const planId = this.getAttribute("plan-id");
    if (!apiUrl || !planId) return this.say("Checkout is missing api-url or plan-id.", "error");

    this.button.disabled = true;
    this.say("Approve the spending limit in your wallet.");
    try {
      const budgetAttr = this.getAttribute("budget-usdc");
      const sub: SubscriptionView = await new Tabline({
        apiUrl,
        walletConnectProjectId: this.getAttribute("walletconnect-project-id") ?? undefined,
      }).subscribe({
        planId,
        budget: budgetAttr ? parseUsdc(budgetAttr) : undefined,
      });
      this.say(`Tab opened. Limit ${formatUsdc(sub.permission.periodAmount)} per period.`);
      this.dispatchEvent(new CustomEvent("tabline:subscribed", { detail: sub, bubbles: true, composed: true }));
    } catch (e) {
      const err = e instanceof TablineError ? e : new TablineError("error", (e as Error).message);
      this.say(err.message, "error");
      this.dispatchEvent(new CustomEvent("tabline:error", { detail: { code: err.code, message: err.message }, bubbles: true, composed: true }));
    } finally {
      this.button.disabled = false;
    }
  }
}

export function defineCheckout(tag = "tabline-checkout") {
  if (!customElements.get(tag)) customElements.define(tag, TablineCheckout);
}
