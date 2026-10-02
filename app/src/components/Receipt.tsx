import { formatDuration, formatUsdc } from "@tabline/sdk";
import type { ChargeView, PlanView, SubscriptionView, UsageView } from "../lib/backend";
import { fmtDate, shortAddr } from "../lib/hooks";

export function planTitle(plan: PlanView): string {
  return plan.kind === "fixed" ? `${formatUsdc(plan.amount)} USDC per ${formatDuration(plan.period)}` : "Pay as you go";
}

interface Props {
  sub: SubscriptionView;
  plan?: PlanView;
  charges: ChargeView[];
  usage?: UsageView[];
  /** Overrides the automatic stamp. */
  stamp?: { title: string; note: string };
  children?: React.ReactNode;
}

const STATUS_LABEL: Record<string, string> = { active: "Open", past_due: "Payment failing", cancelled: "Cancelled", expired: "Permission expired" };

/** The signature element: a tab as a till-roll receipt, with the spending limit drawn as part of the paper. */
export function Receipt({ sub, plan, charges, usage = [], stamp, children }: Props) {
  const limit = BigInt(sub.budget.limit);
  const settled = BigInt(sub.budget.settled);
  const pending = BigInt(sub.budget.pending);
  const pct = (v: bigint) => (limit === 0n ? 0 : Math.min(100, Number((v * 10000n) / limit) / 100));

  const closed =
    stamp ??
    (sub.status === "cancelled"
      ? { title: "Tab closed", note: "Cancelled by the subscriber" }
      : sub.status === "expired"
        ? { title: "Tab closed", note: "The wallet permission expired" }
        : BigInt(sub.budget.remaining) === 0n && plan?.kind === "metered"
          ? { title: "Tab closed", note: "Spending limit reached" }
          : undefined);

  const lines = [
    ...charges.map((c) => ({ key: c.id, at: c.at, label: c.status === "failed" ? "Charge failed" : c.kind === "fixed" ? "Subscription" : "Usage settled", amount: c.amount, tone: c.status === "failed" ? "bad" : "ok" })),
    ...usage.filter((u) => u.status === "pending").map((u) => ({ key: u.id, at: u.at, label: u.label ?? "Usage", amount: u.amount, tone: "wait" })),
  ].sort((a, b) => a.at - b.at);

  return (
    <article className="receipt" aria-label={`Tab for ${plan ? planTitle(plan) : "plan " + sub.planId}`}>
      <header className="receipt__head">
        <h3>{plan ? planTitle(plan) : `Plan ${sub.planId}`}</h3>
        <p>
          {shortAddr(sub.subscriber)}, opened {fmtDate(sub.createdAt)}
        </p>
        <p className={`status status--${sub.status}`}>{STATUS_LABEL[sub.status]}</p>
      </header>

      <ol className="receipt__lines">
        {lines.length === 0 && <li className="line line--empty">Nothing charged yet.</li>}
        {lines.map((l) => (
          <li key={l.key} className={`line line--${l.tone}`}>
            <span className="line__label">
              {l.label}
              <small>{fmtDate(l.at)}{l.tone === "wait" ? ", settles soon" : ""}</small>
            </span>
            <span className="line__leader" aria-hidden />
            <span className="line__amount">{l.tone === "bad" ? "not paid" : formatUsdc(l.amount)}</span>
          </li>
        ))}
      </ol>

      <div className="limit" role="group" aria-label="Spending limit">
        <div className="limit__bar" role="img" aria-label={`Spent ${formatUsdc(settled)} of ${formatUsdc(limit)}, pending ${formatUsdc(pending)}`}>
          <span className="limit__spent" style={{ width: `${pct(settled)}%` }} />
          <span className="limit__pending" style={{ width: `${pct(pending)}%` }} />
        </div>
        <p className="limit__text">
          Limit {formatUsdc(limit)} per {formatDuration(sub.permission.periodDuration)}. Left {formatUsdc(sub.budget.remaining)}.
        </p>
      </div>

      <footer className="receipt__foot">
        <span>Total paid</span>
        <strong>{formatUsdc(sub.onchain?.totalPaid ?? "0")} USDC</strong>
      </footer>

      {sub.status === "past_due" && sub.lastError && <p className="receipt__warn">{sub.lastError}</p>}
      {closed && (
        <div className="stamp" role="status">
          <b>{closed.title}</b>
          <span>{closed.note}</span>
        </div>
      )}
      {children && <div className="receipt__actions">{children}</div>}
    </article>
  );
}
