import { Tabline, TablineError, type ChargeView, type PlanView, type SubscriptionView } from "@tabline/sdk";
import { WALLETCONNECT_PROJECT_ID } from "./env";

export type { ChargeView, PlanView, SubscriptionView };
export { TablineError };

export interface UsageView {
  id: string;
  subscriptionId: string;
  amount: string;
  units: string;
  label?: string;
  status: "pending" | "settled";
  at: number;
}

export interface SubscriptionDetail extends SubscriptionView {
  charges: ChargeView[];
  usage: UsageView[];
}

export interface Overview {
  activeSubscriptions: number;
  pastDue: number;
  cancelled: number;
  monthlyRecurring: string;
  collected30d: string;
  failed30d: number;
  pendingUsage: string;
}

export interface EventView {
  id: string;
  type: string;
  at: number;
  data: Record<string, unknown>;
}

/** Everything the UI needs. One implementation talks to the keeper, one simulates it. */
export interface Backend {
  readonly demo: boolean;
  connect(): Promise<string>;
  connectWalletConnect(): Promise<string>;
  connectedAccount(): Promise<string | undefined>;
  merchantLogin(): Promise<string>;
  merchantLoginWalletConnect(): Promise<string>;
  merchantSession(): Promise<string | undefined>;
  merchantLogout(): Promise<void>;
  plan(id: string): Promise<PlanView>;
  subscribe(planId: string, budget?: bigint): Promise<SubscriptionView>;
  subscriptions(subscriber: string): Promise<SubscriptionView[]>;
  subscription(id: string): Promise<SubscriptionDetail>;
  cancel(id: string, onchain: boolean): Promise<SubscriptionView>;
  // merchant
  allSubscriptions(): Promise<SubscriptionView[]>;
  allCharges(): Promise<ChargeView[]>;
  overview(): Promise<Overview>;
  events(): Promise<EventView[]>;
  runBilling(): Promise<void>;
  retry(id: string): Promise<void>;
  cancelAsMerchant(id: string): Promise<void>;
  postUsage(a: { subscriptionId: string; amount: bigint; idempotencyKey: string; label?: string }): Promise<{ remaining: string }>;
  createPlan(a: { amount: bigint; periodSeconds: number; kind: "fixed" | "metered"; payout: string; token: string }): Promise<string>;
}

export class HttpBackend implements Backend {
  readonly demo = false;
  private sdk: Tabline;

  constructor(
    private readonly apiUrl: string,
  ) {
    this.sdk = new Tabline({ apiUrl, walletConnectProjectId: WALLETCONNECT_PROJECT_ID });
  }

  private async req<T>(path: string, init: { method?: string; body?: unknown; merchant?: boolean } = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.apiUrl.replace(/\/$/, "") + path, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("Tabline billing request failed", { url: this.apiUrl + path, detail, origin: typeof window === "undefined" ? "server" : window.location.origin });
      throw new TablineError(
        "network",
        `Could not reach the billing service at ${this.apiUrl}. Request: ${path}. Browser detail: ${detail}`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new TablineError(data?.error?.code ?? "error", data?.error?.message ?? res.statusText, res.status, data?.error ?? {});
    return data as T;
  }

  connect = () => this.sdk.connect();
  connectWalletConnect = () => this.sdk.connectWalletConnect();
  connectedAccount = () => this.sdk.connectedAccount();
  merchantLogin = () => this.sdk.merchantLogin();
  merchantLoginWalletConnect = () => this.sdk.merchantLoginWalletConnect();
  merchantSession = () => this.sdk.merchantSession();
  merchantLogout = async () => { await this.sdk.merchantLogout(); };
  plan = (id: string) => this.sdk.plan(id);
  subscribe = (planId: string, budget?: bigint) => this.sdk.subscribe({ planId, budget });
  subscriptions = (subscriber: string) => this.sdk.subscriptions(subscriber);
  subscription = (id: string) => this.req<SubscriptionDetail>(`/v1/subscriptions/${id}`);
  cancel = (id: string, onchain: boolean) => this.sdk.cancel(id, { onchain });

  allSubscriptions = async () => (await this.req<{ data: SubscriptionView[] }>("/v1/subscriptions")).data;
  allCharges = async () => (await this.req<{ data: ChargeView[] }>("/v1/charges")).data;
  overview = () => this.req<Overview>("/v1/merchant/overview");
  events = async () => (await this.req<{ data: EventView[] }>("/v1/events")).data;
  runBilling = async () => void (await this.req("/v1/engine/run", { method: "POST" }));
  retry = async (id: string) => void (await this.req(`/v1/subscriptions/${id}/retry`, { method: "POST" }));
  cancelAsMerchant = async (id: string) => void (await this.req(`/v1/subscriptions/${id}/cancel`, { method: "POST" }));
  postUsage = async (a: { subscriptionId: string; amount: bigint; idempotencyKey: string; label?: string }) => {
    const r = await this.req<{ budget: { remaining: string } }>("/v1/usage", {
      body: { subscriptionId: a.subscriptionId, amount: a.amount.toString(), idempotencyKey: a.idempotencyKey, label: a.label, units: "1" },
    });
    return { remaining: r.budget.remaining };
  };
  createPlan = (a: { amount: bigint; periodSeconds: number; kind: "fixed" | "metered"; payout: string; token: string }) =>
    this.sdk.createPlan({ ...a, payout: a.payout as `0x${string}`, token: a.token as `0x${string}` });
}
