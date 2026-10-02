import { useEffect, useState } from "react";
import Link from "next/link";
import { DemoNotice, ErrorNote, LoadingNote } from "../components/Bits";
import { Receipt } from "../components/Receipt";
import { backend, IS_DEMO } from "../lib/env";
import { shortAddr, useAsync } from "../lib/hooks";
import type { PlanView, SubscriptionDetail } from "../lib/backend";

export function Tabs() {
  const [account, setAccount] = useState<string>();
  const [error, setError] = useState<string>();

  async function connect() {
    setError(undefined);
    try {
      setAccount(await backend.connect());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const tabs = useAsync(
    async () => {
      if (!account) return [];
      const subs = await backend.subscriptions(account);
      const plans = new Map<string, PlanView>();
      const out: { detail: SubscriptionDetail; plan?: PlanView }[] = [];
      for (const s of subs) {
        if (!plans.has(s.planId)) plans.set(s.planId, await backend.plan(s.planId));
        out.push({ detail: await backend.subscription(s.id), plan: plans.get(s.planId) });
      }
      return out;
    },
    [account],
    8000,
  );

  return (
    <div className="page">
      {IS_DEMO && <DemoNotice />}
      <h1>My tabs</h1>
      <p className="lede">Every recurring payment you have opened, with the limit you set for each.</p>

      {!account ? (
        <div className="gate">
          <button className="btn btn--primary" onClick={connect}>
            Connect wallet
          </button>
          <ErrorNote message={error} />
        </div>
      ) : (
        <>
          <p className="hint">Showing tabs for {shortAddr(account)}.</p>
          <ErrorNote message={tabs.error} />
          {tabs.loading && <LoadingNote message="Loading your tabs…" />}
          {tabs.data?.length === 0 && !tabs.loading && (
            <p className="empty">
              No tabs yet. Open one from the <Link href="/">shop</Link>.
            </p>
          )}
          <div className="receipts">
            {tabs.data?.map(({ detail, plan }) => (
              <Receipt key={detail.id} sub={detail} plan={plan} charges={detail.charges} usage={detail.usage}>
                {detail.status === "active" || detail.status === "past_due" ? <CancelControl id={detail.id} onDone={tabs.reload} /> : null}
              </Receipt>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CancelControl({ id, onDone }: { id: string; onDone: () => void }) {
  const [step, setStep] = useState<"idle" | "confirm">("idle");
  const [onchain, setOnchain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      await backend.cancel(id, onchain);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (step === "idle") {
    return (
      <button className="btn btn--ghost" onClick={() => setStep("confirm")}>
        Cancel this tab
      </button>
    );
  }
  return (
    <div className="confirm">
      <p>Future charges stop right away. Your wallet permission stays in place until you revoke it in your wallet, so do that too.</p>
      <label className="check">
        <input type="checkbox" checked={onchain} onChange={(e) => setOnchain(e.target.checked)} />
        Also record the cancel on Arbitrum (costs a little gas)
      </label>
      <div className="row">
        <button className="btn btn--danger" onClick={confirm} disabled={busy}>
          {busy ? "Waiting for your wallet" : "Cancel tab"}
        </button>
        <button className="btn btn--ghost" onClick={() => setStep("idle")} disabled={busy}>
          Keep it open
        </button>
      </div>
      <ErrorNote message={error} />
    </div>
  );
}
