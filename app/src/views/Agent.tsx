import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatUsdc, parseUsdc } from "@tabline/sdk";
import { DemoNotice, ErrorNote, LoadingNote } from "../components/Bits";
import { Receipt } from "../components/Receipt";
import { backend, IS_DEMO, PLAN_METERED } from "../lib/env";
import { useAsync } from "../lib/hooks";
import type { SubscriptionDetail } from "../lib/backend";

const COST = parseUsdc("0.50");
const TASKS = [
  "Proofread onboarding email",
  "Check pricing page copy",
  "Review release notes",
  "Fix grammar in support macro",
  "Polish investor update",
  "Check changelog entry",
  "Tighten homepage headline",
  "Review docs introduction",
];

export function Agent() {
  const [account, setAccount] = useState<string>();
  const [subId, setSubId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<{ id: number; text: string; tone: "ok" | "stop" }[]>([]);
  const [error, setError] = useState<string>();
  const n = useRef(0);
  const stopRef = useRef(false);

  useEffect(() => {
    if (!account) return;
    backend.subscriptions(account).then((subs) => {
      const live = subs.find((s) => s.planId === PLAN_METERED && (s.status === "active" || s.status === "past_due"));
      setSubId(live?.id ?? subs.find((s) => s.planId === PLAN_METERED)?.id);
    }).catch((e: Error) => setError(e.message));
  }, [account]);

  const detail = useAsync<SubscriptionDetail | undefined>(() => (subId ? backend.subscription(subId) : Promise.resolve(undefined)), [subId], 1500);
  const plan = useAsync(() => backend.plan(PLAN_METERED), []);

  const push = (text: string, tone: "ok" | "stop") => setLog((l) => [{ id: ++n.current, text, tone }, ...l].slice(0, 30));

  async function start() {
    if (!subId) return;
    stopRef.current = false;
    setRunning(true);
    setError(undefined);
    for (let i = 0; !stopRef.current; i++) {
      const task = TASKS[i % TASKS.length];
      try {
        const r = await backend.postUsage({ subscriptionId: subId, amount: COST, idempotencyKey: `agent-${Date.now()}-${i}`, label: task });
        push(`${task}: ${formatUsdc(COST)} USDC. ${formatUsdc(r.remaining)} left.`, "ok");
        detail.reload();
      } catch (e) {
        const msg = (e as Error).message;
        push(`Stopped. ${msg}`, "stop");
        detail.reload();
        break;
      }
      await new Promise((r) => setTimeout(r, 900));
    }
    setRunning(false);
  }

  return (
    <div className="page">
      {IS_DEMO && <DemoNotice />}
      <h1>An agent on a budget</h1>
      <p className="lede">
        An agent calls Inkwell on your behalf. Each call adds a line to your tab. When the limit you set is spent, the next call is refused, and the agent cannot
        talk its way past it.
      </p>
      <p className="hint">In this demo the browser plays Inkwell's API gateway and reports usage itself. In production that call comes from the merchant's server.</p>

      {!account ? (
        <div className="gate">
          <button className="btn btn--primary" onClick={async () => setAccount(await backend.connect().catch((e: Error) => (setError(e.message), undefined)))}>
            Connect wallet
          </button>
        </div>
      ) : !subId ? (
        <p className="empty">
          You have no pay-as-you-go tab yet. Open one from the <Link href="/">shop</Link> with a small limit, then come back.
        </p>
      ) : (
        <div className="agent">
          <div>
            <div className="row">
              <button className="btn btn--primary" onClick={start} disabled={running}>
                {running ? "Agent is working" : "Start the agent"}
              </button>
              {running && (
                <button className="btn btn--ghost" onClick={() => (stopRef.current = true)}>
                  Pause
                </button>
              )}
            </div>
            <p className="hint">Each check costs {formatUsdc(COST)} USDC.</p>
            <ol className="agentlog" aria-live="polite">
              {log.map((l) => (
                <li key={l.id} className={l.tone === "stop" ? "stop" : ""}>{l.text}</li>
              ))}
            </ol>
          </div>
          {detail.loading && <LoadingNote message="Loading tab activity…" />}
          {detail.data && <Receipt sub={detail.data} plan={plan.data} charges={detail.data.charges} usage={detail.data.usage} />}
        </div>
      )}
      <ErrorNote message={error ?? detail.error} />
    </div>
  );
}
