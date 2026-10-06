import { useEffect, useState } from "react";
import Link from "next/link";
import { defineCheckout, formatUsdc, parseUsdc } from "@tabline/sdk";
import { DemoNotice, ErrorNote } from "../components/Bits";
import { Receipt } from "../components/Receipt";
import { backend, IS_DEMO, KEEPER_API_URL, PLAN_FIXED, PLAN_METERED, WALLETCONNECT_PROJECT_ID } from "../lib/env";
import { useAsync } from "../lib/hooks";
import type { SubscriptionDetail, SubscriptionView } from "../lib/backend";

const BUDGETS = ["10", "25", "50"];

function planError(message?: string): string | undefined {
  if (!message) return undefined;
  if (message.toLowerCase().includes("does not exist")) {
    return "The configured billing plan is not deployed on this Tabline contract. Create the plan in Merchant, then update NEXT_PUBLIC_PLAN_FIXED/NEXT_PUBLIC_PLAN_METERED if needed.";
  }
  if (message.toLowerCase().includes("chain_unavailable")) {
    return "The keeper cannot read plans from the blockchain. Check its RPC_URL configuration.";
  }
  return message;
}

export function Shop() {
  const fixed = useAsync(() => backend.plan(PLAN_FIXED), []);
  const metered = useAsync(() => backend.plan(PLAN_METERED), []);
  const [choice, setChoice] = useState<"fixed" | "metered">("fixed");
  const [budget, setBudget] = useState("25");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [opened, setOpened] = useState<SubscriptionDetail>();
  const [account, setAccount] = useState<string>();
  const [subscriptions, setSubscriptions] = useState<SubscriptionView[]>([]);

  useEffect(() => defineCheckout(), []);

  const plan = choice === "fixed" ? fixed.data : metered.data;
  const existing = plan && subscriptions.find((s) => s.planId === plan.id && (s.status === "active" || s.status === "past_due"));

  async function open() {
    if (!plan) return;
    setBusy(true);
    setError(undefined);
    try {
      let connected = account;
      if (!connected) {
        connected = await backend.connect();
        setAccount(connected);
        const current = await backend.subscriptions(connected);
        setSubscriptions(current);
        if (current.some((s) => s.planId === plan.id && (s.status === "active" || s.status === "past_due"))) return;
      } else if (existing) {
        return;
      }
      const sub = await backend.subscribe(plan.id, choice === "metered" ? parseUsdc(budget) : undefined);
      setOpened(await backend.subscription(sub.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      {IS_DEMO && <DemoNotice />}
      <section className="shop">
        <div className="shop__pitch">
          <h1>Inkwell checks your writing while you type.</h1>
          <p className="lede">A proofreading API for editors and writing tools. Pay monthly, or pay only for the checks you run.</p>
          <p>
            You never hand Inkwell an open approval. You set a limit in your wallet, Inkwell can charge up to that limit and nothing beyond it, and you can
            close the tab whenever you like.
          </p>
        </div>

        <div className="shop__open">
          <h2>Choose how to pay</h2>
          <div className="choices" role="radiogroup" aria-label="Plan">
            <label className={`choice ${choice === "fixed" ? "choice--on" : ""}`}>
              <input type="radio" name="plan" checked={choice === "fixed"} onChange={() => setChoice("fixed")} />
              <span>
                <b>Editor</b>
                <small>{fixed.data ? `${formatUsdc(fixed.data.amount)} USDC every month, unlimited checks` : "Loading plan"}</small>
              </span>
            </label>
            <label className={`choice ${choice === "metered" ? "choice--on" : ""}`}>
              <input type="radio" name="plan" checked={choice === "metered"} onChange={() => setChoice("metered")} />
              <span>
                <b>Pay as you go</b>
                <small>{metered.data ? `Each check is billed as you use it, settled in batches of up to ${formatUsdc(metered.data.amount)} USDC` : "Loading plan"}</small>
              </span>
            </label>
          </div>

          {choice === "metered" && (
            <div className="field">
              <label htmlFor="budget">Monthly spending limit</label>
              <select id="budget" value={budget} onChange={(e) => setBudget(e.target.value)}>
                {BUDGETS.map((b) => (
                  <option key={b} value={b}>
                    {b} USDC per month
                  </option>
                ))}
              </select>
              <p className="hint">Once this is spent, Inkwell stops charging until the next month.</p>
            </div>
          )}

          <button className="btn btn--primary btn--wide" onClick={open} disabled={busy || !plan || Boolean(existing)}>
            {busy ? "Waiting for your wallet" : existing ? "Already subscribed" : "Open a tab"}
          </button>
          {existing && <p className="hint">You already have an open {choice === "fixed" ? "Editor" : "pay-as-you-go"} tab for this wallet. View it in <Link href="/tabs">My tabs</Link>.</p>}
          <ErrorNote message={error ?? planError(fixed.error) ?? planError(metered.error)} />
        </div>
      </section>

      {opened && (
        <section className="after">
          <h2>Your tab is open</h2>
          <Receipt sub={opened} plan={plan} charges={opened.charges} usage={opened.usage}>
            <Link className="btn btn--ghost" href="/tabs">
              See it in My tabs
            </Link>
          </Receipt>
        </section>
      )}

      <section className="embed">
        <h2>Embedded checkout</h2>
        <p>Give subscribers a simple, wallet-first payment experience. Tabline handles the permission request and keeps every spending limit visible.</p>
        <div className="embed__benefits">
          <div><strong>Wallet-first</strong><span>Subscribers approve payments in their own wallet.</span></div>
          <div><strong>Clear limits</strong><span>Every tab is capped and revocable.</span></div>
          <div><strong>Ready to share</strong><span>A focused checkout flow with no extra dashboard steps.</span></div>
        </div>
        <div className="embed__live">
          <p className="hint">Live checkout preview</p>
          <tabline-checkout api-url={KEEPER_API_URL} plan-id={PLAN_FIXED} label="Subscribe with Tabline" walletconnect-project-id={WALLETCONNECT_PROJECT_ID || undefined} />
        </div>
      </section>
    </div>
  );
}
