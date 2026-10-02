import type { Address, Hex } from "viem";

/** Amounts are token base units (USDC = 6 decimals) serialized as decimal strings so JSON never loses precision. */
export type Amount = string;

export type SubStatus = "active" | "past_due" | "needs_review" | "cancelled" | "expired";

/** The parts of an ERC-7715 permission response the keeper needs in order to redeem it. */
export interface StoredGrant {
  context: Hex;
  delegationManager: Address;
  chainId: number;
  from: Address;
  to: Address;
  tokenAddress: Address;
  periodAmount: Amount;
  periodDuration: number;
  /** Unix seconds. */
  expiry: number;
}

export interface SubscriptionRecord {
  id: string;
  planId: string;
  subscriber: Address;
  chainId: number;
  grant: StoredGrant;
  status: SubStatus;
  failures: number;
  /** Unix seconds; the engine will not retry before this. */
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
}

export interface ChargeRecord {
  id: string;
  subscriptionId: string;
  planId: string;
  subscriber: Address;
  chargeKey: Hex;
  amount: Amount;
  kind: "fixed" | "metered";
  status: "succeeded" | "failed";
  txHash?: Hex;
  error?: string;
  at: number;
}

export interface UsageRecord {
  id: string;
  subscriptionId: string;
  idempotencyKey: string;
  amount: Amount;
  units: string;
  label?: string;
  status: "pending" | "settled";
  chargeId?: string;
  at: number;
}

export type WebhookEventType =
  | "subscription.created"
  | "charge.succeeded"
  | "charge.failed"
  | "subscription.past_due"
  | "subscription.needs_review"
  | "subscription.expired"
  | "subscription.cancelled";

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  at: number;
  data: Record<string, unknown>;
}

export interface Plan {
  merchant: Address;
  keeper: Address;
  payout: Address;
  token: Address;
  amount: bigint;
  period: number;
  kind: "fixed" | "metered";
  active: boolean;
}

export interface OnchainSubscription {
  startedAt: number;
  nextDueAt: number;
  cancelled: boolean;
  totalPaid: bigint;
}
