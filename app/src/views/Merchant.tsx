import { useEffect, useState } from "react";
import { isAddress } from "viem";
import { formatUsdc, parseUsdc } from "@tabline/sdk";
import { DemoNotice, ErrorNote, LoadingNote } from "../components/Bits";
import { backend, IS_DEMO, TOKEN_ADDRESS } from "../lib/env";
import { fmtDate, fmtDateTime, shortAddr, useAsync } from "../lib/hooks";

const STATUS: Record<string, string> = { active: "Open", past_due: "Payment failing", cancelled: "Cancelled", expired: "Expired" };
const EVENT: Record<string, string> = {
  "subscription.created": "New subscriber",
  "charge.succeeded": "Charge collected",
  "charge.failed": "Charge failed",
  "subscription.past_due": "Subscriber marked past due",
  "subscription.expired": "Permission expired",
  "subscription.cancelled": "Subscription cancelled",
};

export function Merchant() {
  const [merchant, setMerchant] = useState<string>();
  const [checking, setChecking] = useState(!IS_DEMO);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (IS_DEMO) return;
    backend.merchantSession().then((address) => setMerchant(address)).finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="page"><h1>Merchant dashboard</h1><LoadingNote message="Checking merchant session…" /></div>;
  if (!merchant && !IS_DEMO) {
    return (
      <div className="page">
        <h1>Merchant dashboard</h1>
        <p className="lede">Connect the merchant wallet to view and manage billing.</p>
        <button className="btn btn--primary" onClick={async () => {
          setError(undefined);
          try { setMerchant(await backend.merchantLogin()); } catch (e) { setError((e as Error).message); }
        }}>Connect merchant wallet</button>
        <ErrorNote message={error} />
      </div>
    );
  }
  return <Dashboard />;
}

function Dashboard() {
  const overview = useAsync(() => backend.overview(), [], 10000);
  const subs = useAsync(() => backend.allSubscriptions(), [], 10000);
  const charges = useAsync(() => backend.allCharges(), [], 10000);
  const events = useAsync(() => backend.events(), [], 10000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmingCancel, setConfirmingCancel] = useState<string>();

  const refresh = () => [overview, subs, charges, events].forEach((a) => a.reload());
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const o = overview.data;

  return (
    <div className="page">
      {IS_DEMO && <DemoNotice />}
      <div className="titlerow">
        <h1>Merchant dashboard</h1>
      </div>
      <ErrorNote message={error ?? overview.error} />

      <dl className="figures">
        <div><dt>Monthly recurring</dt><dd>{o ? formatUsdc(o.monthlyRecurring) : "..."} USDC</dd></div>
        <div><dt>Collected in 30 days</dt><dd>{o ? formatUsdc(o.collected30d) : "..."} USDC</dd></div>
        <div><dt>Open tabs</dt><dd>{o?.activeSubscriptions ?? "..."}</dd></div>
        <div><dt>Payment failing</dt><dd className={o && o.pastDue > 0 ? "bad" : ""}>{o?.pastDue ?? "..."}</dd></div>
        <div><dt>Usage not yet settled</dt><dd>{o ? formatUsdc(o.pendingUsage) : "..."} USDC</dd></div>
      </dl>

      <section>
        <h2>Subscribers</h2>
        {subs.loading && <LoadingNote message="Loading subscribers…" />}
        {subs.data?.length === 0 && <p className="empty">No subscribers yet. Share the checkout element from the shop page.</p>}
        {!!subs.data?.length && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Account</th><th>Plan</th><th>Status</th><th>Paid</th><th>Next charge</th><th><span className="sr">Actions</span></th></tr>
              </thead>
              <tbody>
                {subs.data.map((s) => (
                  <tr key={s.id}>
                    <td>{shortAddr(s.subscriber)}</td>
                    <td>{s.planId}</td>
                    <td className={`status status--${s.status}`}>{STATUS[s.status]}</td>
                    <td>{formatUsdc(s.onchain?.totalPaid ?? "0")}</td>
                    <td>{s.onchain && s.status === "active" && s.onchain.nextDueAt ? fmtDate(s.onchain.nextDueAt) : "None scheduled"}</td>
                    <td className="actions">
                      {s.status === "past_due" && <button className="link" onClick={() => act(() => backend.retry(s.id))} disabled={busy}>Retry now</button>}
                      {(s.status === "active" || s.status === "past_due") &&
                        (confirmingCancel === s.id ? (
                          <>
                            <span>Cancel this tab?</span>
                            <button className="link" onClick={() => act(() => backend.cancelAsMerchant(s.id)).finally(() => setConfirmingCancel(undefined))} disabled={busy}>Confirm</button>
                            <button className="link" onClick={() => setConfirmingCancel(undefined)} disabled={busy}>Keep open</button>
                          </>
                        ) : (
                          <button className="link" onClick={() => setConfirmingCancel(s.id)} disabled={busy}>Cancel</button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="twocol">
        <section>
          <h2>Ledger</h2>
          {charges.loading && <LoadingNote message="Loading charges…" />}
          <ol className="ledger">
            {charges.data?.slice(0, 12).map((c) => (
              <li key={c.id} className={c.status === "failed" ? "line line--bad" : "line line--ok"}>
                <span className="line__label">{shortAddr(c.subscriber)}<small>{fmtDateTime(c.at)}{c.error ? `, ${c.error}` : ""}</small></span>
                <span className="line__leader" aria-hidden />
                <span className="line__amount">{c.status === "failed" ? "not paid" : formatUsdc(c.amount)}</span>
              </li>
            ))}
            {charges.data?.length === 0 && <li className="empty">No charges yet.</li>}
          </ol>
        </section>
        <section>
          <h2>Activity</h2>
          {events.loading && <LoadingNote message="Loading activity…" />}
          <ul className="feed">
            {events.data?.slice(0, 12).map((e) => (
              <li key={e.id}><span>{EVENT[e.type] ?? e.type}</span><small>{fmtDateTime(e.at)}</small></li>
            ))}
            {events.data?.length === 0 && <li className="empty">Nothing has happened yet.</li>}
          </ul>
        </section>
      </div>

      <NewPlan onCreated={refresh} />
    </div>
  );
}

function NewPlan({ onCreated }: { onCreated: () => void }) {
  const [kind, setKind] = useState<"fixed" | "metered">("fixed");
  const [amount, setAmount] = useState("9");
  const [days, setDays] = useState("30");
  const [payout, setPayout] = useState("");
  const [token, setToken] = useState(TOKEN_ADDRESS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setCreated(undefined);
    try {
      const parsedAmount = parseUsdc(amount);
      const periodSeconds = Number(days) * 86400;
      if (parsedAmount <= 0n) throw new Error("Price must be greater than zero.");
      if (kind === "fixed" && (!Number.isFinite(periodSeconds) || periodSeconds <= 0)) throw new Error("Days between charges must be greater than zero.");
      if (!isAddress(payout)) throw new Error("Enter a valid payout address.");
      if (!isAddress(token)) throw new Error("Enter a valid token address.");
      const id = await backend.createPlan({ amount: parsedAmount, periodSeconds, kind, payout, token });
      setCreated(id);
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Create a plan</h2>
      <form className="planform" onSubmit={submit}>
        <div className="field">
          <label htmlFor="kind">Billing style</label>
          <select id="kind" value={kind} onChange={(e) => setKind(e.target.value as "fixed" | "metered")}>
            <option value="fixed">Fixed price on a schedule</option>
            <option value="metered">Pay as you go</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="amount">{kind === "fixed" ? "Price per period (USDC)" : "Largest single settlement (USDC)"}</label>
          <input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" min="0" step="0.01" required />
        </div>
        {kind === "fixed" && (
          <div className="field">
            <label htmlFor="days">Days between charges</label>
          <input id="days" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" min="1" step="1" required />
          </div>
        )}
        <div className="field">
          <label htmlFor="payout">Payout address</label>
          <input id="payout" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="0x..." required />
        </div>
        <div className="field">
          <label htmlFor="token">Token address</label>
          <input id="token" value={token} onChange={(e) => setToken(e.target.value)} placeholder="0x... token contract on the keeper chain" required />
          <p className="hint">Use the token contract on the same network as the keeper. The app intentionally does not guess a token address.</p>
        </div>
        <button className="btn btn--primary" disabled={busy}>{busy ? "Waiting for your wallet" : "Create plan"}</button>
        <ErrorNote message={error} />
        {created && <p className="ok" role="status">Plan {created} created.</p>}
      </form>
    </section>
  );
}
