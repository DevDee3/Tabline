export interface PlanView {
  id: string;
  /** Hex addresses. Typed as plain `string` here (rather than viem's branded Address) so this view type is easy
   *  to construct in app code (tests, demo data) without casts; the SDK casts internally wherever it needs to
   *  pass one of these into a viem call. */
  merchant: string;
  payout: string;
  token: string;
  amount: string;
  period: number;
  kind: "fixed" | "metered";
  active: boolean;
}

export interface SubscriptionView {
  id: string;
  planId: string;
  subscriber: string;
  status: "active" | "past_due" | "needs_review" | "cancelled" | "expired";
  failures: number;
  lastError?: string;
  nextAttemptAt: number;
  createdAt: number;
  permission: { token: string; periodAmount: string; periodDuration: number; expiry: number };
  onchain?: { startedAt: number; nextDueAt: number; totalPaid: string; cancelled: boolean };
  budget: { limit: string; settled: string; pending: string; remaining: string };
}

export interface ChargeView {
  id: string;
  subscriptionId: string;
  planId: string;
  subscriber: string;
  amount: string;
  kind: "fixed" | "metered";
  status: "succeeded" | "failed";
  txHash?: string;
  error?: string;
  at: number;
}

export interface TablineApiError {
  error: { code: string; message: string; [k: string]: unknown };
}

/**
 * `code` is a short machine-readable reason (e.g. "no_wallet", "budget_exceeded"). `status` is an HTTP-style
 * status code when this wraps an API error (0 if not applicable, e.g. a wallet-side failure). `extra` carries
 * any additional structured detail the API returned (e.g. { remaining, limit } for budget_exceeded).
 */
export class TablineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 0,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TablineError";
  }
}
