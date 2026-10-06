import { TablineError, type ChargeView, type PlanView, type SubscriptionView } from "./types";
export { TablineError, type SubscriptionView };

export interface TablineClientOptions {
  /** Base URL of a running Tabline keeper, e.g. https://api.yourservice.com */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/** Thin, fully-typed wrapper over the Tabline keeper's HTTP API. Works in the browser or on a server. */
export class TablineClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: TablineClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    // Browser fetch requires the Window/globalThis receiver when called as a stored method.
    // Bind the default implementation; injected test/server fetch implementations remain untouched.
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? (init.body ? "POST" : "GET"),
        headers,
        credentials: "include",
        // ERC-7715 wallet responses may contain bigint values. JSON has no bigint type;
        // the keeper accepts decimal or hex strings and normalizes them during validation.
        body: init.body ? JSON.stringify(init.body, (_key, value) => (typeof value === "bigint" ? value.toString() : value)) : undefined,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("Tabline billing request failed", { url: `${this.baseUrl}${path}`, detail });
      throw new TablineError("network", `Could not reach the billing service at ${this.baseUrl}. Request: ${path}. Browser detail: ${detail}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = body as { error?: { code: string; message: string; [k: string]: unknown } };
      const { code: _c, message: _m, ...extra } = err.error ?? {};
      throw new TablineError(err.error?.code ?? "unknown", err.error?.message ?? `request failed with status ${res.status}`, res.status, extra);
    }
    return body as T;
  }

  getConfig() {
    return this.request<{ chainId: number; keeperAddress: `0x${string}`; tabline: `0x${string}` }>("/v1/config");
  }

  authNonce(address: `0x${string}`) {
    return this.request<{ address: `0x${string}`; message: string; expiresAt: number }>(`/v1/auth/nonce?address=${encodeURIComponent(address)}`);
  }

  authLogin(address: `0x${string}`, signature: `0x${string}`) {
    return this.request<{ authenticated: true; address: `0x${string}` }>("/v1/auth/login", { method: "POST", body: { address, signature } });
  }

  authSession() {
    return this.request<{ authenticated: true; address: `0x${string}` }>("/v1/auth/session");
  }

  authLogout() {
    return this.request<{ authenticated: false }>("/v1/auth/logout", { method: "POST" });
  }

  getPlan(planId: string | bigint) {
    return this.request<PlanView>(`/v1/plans/${planId}`);
  }

  /** `grant` is the raw array returned by the wallet's `wallet_requestExecutionPermissions` call. */
  subscribe(planId: string | bigint, subscriber: `0x${string}`, grant: unknown) {
    return this.request<SubscriptionView>("/v1/subscriptions", { body: { planId: String(planId), subscriber, grant } });
  }

  getSubscription(id: string) {
    return this.request<SubscriptionView & { charges: ChargeView[] }>(`/v1/subscriptions/${id}`);
  }

  listSubscriptions(filter: { subscriber?: `0x${string}`; planId?: string; status?: string } = {}) {
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    return this.request<{ data: SubscriptionView[] }>(`/v1/subscriptions${qs ? `?${qs}` : ""}`);
  }

  /** `signature` is an EIP-191 personal_sign of `cancelMessage(subscriptionId)` by the subscribing account. */
  cancelWithSignature(subscriptionId: string, signature: `0x${string}`) {
    return this.request<SubscriptionView>(`/v1/subscriptions/${subscriptionId}/cancel`, { body: { signature } });
  }

  cancelAsMerchant(subscriptionId: string) {
    return this.request<SubscriptionView>(`/v1/subscriptions/${subscriptionId}/cancel`, { method: "POST", body: {} });
  }

  /** Server-side only: report metered usage. `idempotencyKey` must be unique per billable event (e.g. a request id). */
  recordUsage(args: { subscriptionId: string; amount: string | bigint; idempotencyKey: string; units?: string; label?: string }) {
    return this.request<{ usage: unknown; replay: boolean; budget: { limit: string; settled: string; pending: string; remaining: string } }>("/v1/usage", {
      body: { ...args, amount: String(args.amount) },
    });
  }

  runEngineCycle() {
    return this.request<{ attempted: number; succeeded: number; failed: number; cancelled: number; expired: number }>("/v1/engine/run", { method: "POST" });
  }

  /** Server-side only: aggregate stats for a merchant dashboard. */
  getOverview() {
    return this.request<{ activeSubscriptions: number; pastDue: number; cancelled: number; monthlyRecurring: string; collected30d: string; failed30d: number; pendingUsage: string }>("/v1/merchant/overview");
  }

  /** Server-side only: force a specific subscription to be attempted again immediately. */
  retry(subscriptionId: string) {
    return this.request<{ report: unknown; subscription: SubscriptionView }>(`/v1/subscriptions/${subscriptionId}/retry`, { method: "POST" });
  }

  /** Server-side only: recent webhook-equivalent event log. */
  listEvents(limit = 100) {
    return this.request<{ data: { id: string; type: string; at: number; data: Record<string, unknown> }[] }>(`/v1/events?limit=${limit}`);
  }

  listCharges(filter: { subscriber?: `0x${string}`; subscriptionId?: string } = {}) {
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    return this.request<{ data: ChargeView[] }>(`/v1/charges${qs ? `?${qs}` : ""}`);
  }
}

export const cancelMessage = (subscriptionId: string) => `Tabline: cancel ${subscriptionId}`;

// ---------------------------------------------------------------------------------------------
// High-level browser convenience wrapper: wallet interaction + the keeper API in one place. This is what the
// checkout widget (checkout.ts) and a merchant/subscriber UI (see ../../app) build on.
// ---------------------------------------------------------------------------------------------

import { createPublicClient, custom, type Address, type Chain, type EIP1193Provider } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { cancelOnchain, createPlanOnchain } from "./contract";
import { requestTab, walletSupportsTabline } from "./wallet";

const KNOWN_CHAINS: Record<number, Chain> = { [arbitrum.id]: arbitrum, [arbitrumSepolia.id]: arbitrumSepolia };
/** Falls back to a minimal synthetic Chain if it's not one we recognize -- enough for wallet RPC calls that only need the id. */
const resolveChain = (chainId: number): Chain => KNOWN_CHAINS[chainId] ?? ({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } } as Chain);
const erc20MetadataAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

type WalletSelector = Awaited<ReturnType<typeof import("@reown/appkit/core")["createAppKit"]>>;
const walletSelectors = new Map<string, Promise<WalletSelector>>();

export interface TablineOptions {
  apiUrl: string;
  /** Injected wallet provider; defaults to `window.ethereum`. Override for tests or non-standard wallets. */
  provider?: EIP1193Provider;
  /** WalletConnect Cloud project ID used when no injected browser wallet is available. */
  walletConnectProjectId?: string;
  /** How long a newly requested permission is valid for. Default: 1 year. */
  expirySeconds?: number;
  /** Override the fetch implementation used for the underlying API calls. Mainly for tests. */
  fetchImpl?: typeof fetch;
  /** Override the RPC used for on-chain reads during createPlan/cancel(onchain: true). Defaults to the wallet's own provider. */
  rpcUrl?: string;
}

export interface SubscribeArgs {
  planId: string | bigint;
  /**
   * Max the subscriber allows per period, in the token's base units. Defaults to the plan's own price -- pass a
   * larger value for a metered plan if the subscriber wants headroom above a single settlement's cap.
   */
  budget?: bigint;
}

/**
 * Wallet-integrated Tabline client. Talks to a keeper (for plans, subscriptions, registering a new tab) and,
 * where the action has to be signed, to the user's own wallet directly (opening a tab, on-chain cancel, and
 * creating a plan, none of which the keeper can or should do on a user's behalf).
 */
export class Tabline {
  private readonly client: TablineClient;
  private provider?: EIP1193Provider;
  private readonly walletConnectProjectId?: string;
  private readonly expirySeconds: number;
  private readonly rpcUrl?: string;

  constructor(opts: TablineOptions) {
    this.client = new TablineClient({ baseUrl: opts.apiUrl, fetchImpl: opts.fetchImpl });
    this.walletConnectProjectId = opts.walletConnectProjectId?.trim() || undefined;
    this.provider = opts.provider ?? (typeof window !== "undefined" ? (window as unknown as { ethereum?: EIP1193Provider }).ethereum : undefined);
    this.expirySeconds = opts.expirySeconds ?? 365 * 24 * 3600;
    if (!Number.isInteger(this.expirySeconds) || this.expirySeconds <= 0) {
      throw new TablineError("invalid_expiry", "Permission expiry must be a positive whole number of seconds.", 400);
    }
    this.rpcUrl = opts.rpcUrl;
  }

  private requireProvider(): EIP1193Provider {
    if (!this.provider) throw new TablineError("no_wallet", "No wallet is connected. Install a browser wallet or configure WalletConnect for mobile wallets.");
    return this.provider;
  }

  private async ensureWalletConnectProvider(): Promise<EIP1193Provider> {
    if (!this.walletConnectProjectId || typeof window === "undefined") {
      throw new TablineError("wallet_connect", "WalletConnect is not configured for this app.");
    }
    try {
      let selectorPromise = walletSelectors.get(this.walletConnectProjectId);
      if (!selectorPromise) {
        selectorPromise = Promise.all([
          import("@reown/appkit/core"),
          import("@reown/appkit-adapter-wagmi"),
        ]).then(([{ createAppKit }, { WagmiAdapter }]) => {
          const wagmiAdapter = new WagmiAdapter({
            networks: [arbitrumSepolia, arbitrum],
            projectId: this.walletConnectProjectId!,
          });
          return createAppKit({
            adapters: [wagmiAdapter],
            projectId: this.walletConnectProjectId!,
            networks: [arbitrumSepolia, arbitrum],
            defaultNetwork: arbitrumSepolia,
            showWallets: true,
            metadata: {
              name: "Tabline",
              description: "Permissioned recurring payments with spending limits.",
              url: window.location.origin,
              icons: [`${window.location.origin}/icon.svg`],
            },
            features: {
              analytics: false,
              allWallets: true,
              email: false,
              socials: false,
            },
          });
        });
        walletSelectors.set(this.walletConnectProjectId, selectorPromise);
      }
      const selector = await selectorPromise;
      const current = selector.getAccount();
      if (!current?.isConnected) {
        await selector.open({ view: "AllWallets" });
        await new Promise<void>((resolve, reject) => {
          let finished = false;
          let unsubscribe: () => void = () => {};
          let timeout: ReturnType<typeof setTimeout>;
          const finish = (action: () => void) => {
            if (finished) return;
            finished = true;
            unsubscribe();
            clearTimeout(timeout);
            action();
          };
          unsubscribe = selector.subscribeAccount((state) => {
            if (state.isConnected) finish(resolve);
          }, "eip155");
          timeout = setTimeout(() => finish(() => reject(new Error("Wallet selection timed out."))), 120_000);
        });
      }
      const provider = (selector.getWalletProvider() ?? selector.getProvider("eip155")) as EIP1193Provider | undefined;
      if (!provider) throw new Error("WalletConnect connected but did not expose an EVM provider.");
      return provider;
    } catch (error) {
      throw new TablineError("wallet_connect", error instanceof Error ? error.message : "WalletConnect could not connect.");
    }
  }

  private async ensureProvider(): Promise<EIP1193Provider> {
    if (this.provider) return this.provider;
    const provider = await this.ensureWalletConnectProvider();
    this.provider = provider;
    return provider;
  }

  /** Replaces the active provider so an app-level WalletConnect session can be reused. */
  setProvider(provider: EIP1193Provider) {
    this.provider = provider;
  }

  /** Explicitly opens the WalletConnect modal for mobile or desktop WalletConnect wallets. */
  async connectWalletConnect(): Promise<Address> {
    const provider = await this.ensureWalletConnectProvider();
    this.provider = provider;
    const accounts = (await provider.request({ method: "eth_accounts" })) as Address[];
    if (!accounts[0]) throw new TablineError("no_account", "No account was returned by WalletConnect.");
    return accounts[0];
  }

  /** Requests account access and returns the connected address. Doesn't touch the keeper. */
  async connect(): Promise<Address> {
    // Always open the configured wallet selector first. This keeps one consistent
    // desktop/mobile flow and lets the user choose MetaMask, Phantom, or another wallet.
    const provider = this.walletConnectProjectId ? await this.ensureWalletConnectProvider() : this.requireProvider();
    this.provider = provider;
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
    if (!accounts[0]) throw new TablineError("no_account", "No account was authorized in the wallet.");
    return accounts[0];
  }

  async merchantLogin(): Promise<Address> {
    const provider = this.walletConnectProjectId ? await this.ensureWalletConnectProvider() : this.requireProvider();
    this.provider = provider;
    const address = await this.connect();
    const { message } = await this.client.authNonce(address);
    const signature = (await (provider.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({ method: "personal_sign", params: [message, address] })) as `0x${string}`;
    await this.client.authLogin(address, signature);
    return address;
  }

  async merchantLoginWalletConnect(): Promise<Address> {
    return this.merchantLogin();
  }

  async merchantSession(): Promise<Address | undefined> {
    try {
      return (await this.client.authSession()).address;
    } catch {
      return undefined;
    }
  }

  merchantLogout() {
    return this.client.authLogout();
  }

  /** Returns an already-authorized wallet account without opening a connection prompt. */
  async connectedAccount(): Promise<Address | undefined> {
    const provider = await this.ensureProvider();
    const accounts = (await provider.request({ method: "eth_accounts" })) as Address[];
    return accounts[0];
  }

  plan(id: string | bigint): Promise<PlanView> {
    return this.client.getPlan(id);
  }

  async subscriptions(subscriber: string): Promise<SubscriptionView[]> {
    const { data } = await this.client.listSubscriptions({ subscriber: subscriber as Address });
    return data;
  }

  async subscribe({ planId, budget }: SubscribeArgs): Promise<SubscriptionView> {
    const provider = this.requireProvider();
    const [config, plan] = await Promise.all([this.client.getConfig(), this.client.getPlan(planId)]);
    const chain = resolveChain(config.chainId);

    // Fail before MetaMask's permission UI if the plan points at an address that is not an ERC-20 on this chain.
    // This catches the common mistake of creating a Sepolia plan with a mainnet token address.
    try {
      await createPublicClient({ chain, transport: custom(provider) }).readContract({
        address: plan.token as Address,
        abi: erc20MetadataAbi,
        functionName: "decimals",
      });
    } catch {
      throw new TablineError(
        "invalid_token",
        `Plan ${plan.id} uses a token that is not a readable ERC-20 on ${chain.name}. Recreate the plan with the token address for the selected network.`,
        400,
        { planId: plan.id, token: plan.token, chainId: config.chainId },
      );
    }

    const supported = await walletSupportsTabline(provider, config.chainId).catch(() => true); // if the check itself fails, let the actual request surface the real error
    if (!supported) {
      throw new TablineError("permission_unsupported", "Your wallet does not support periodic spending permissions on this network yet.");
    }

    const periodAmount = budget ?? BigInt(plan.amount);
    if (periodAmount < BigInt(plan.amount)) {
      throw new TablineError("limit_too_low", `The spending limit must be at least ${plan.amount} token base units.`, 400, {
        required: plan.amount,
        requested: periodAmount.toString(),
      });
    }
    const subscriber = await this.connect();
    const periodDurationSeconds = plan.kind === "fixed" ? plan.period : 30 * 24 * 3600;
    const expiry = Math.floor(Date.now() / 1000) + this.expirySeconds;

    let grant: unknown;
    try {
      grant = await requestTab({
        provider,
        chain,
        keeperAddress: config.keeperAddress,
        tokenAddress: plan.token as Address,
        periodAmount,
        periodDurationSeconds,
        expiry,
        justification: `Tabline plan ${plan.id}`,
      });
    } catch (e) {
      throw new TablineError("permission_denied", (e as Error).message || "The wallet permission request was rejected or failed.");
    }

    return this.client.subscribe(planId, subscriber, grant);
  }

  /**
   * Stops future charges. Always signs and submits the cancel message to the keeper first (immediate, free).
   * With `{ onchain: true }`, also sends a real Tabline.cancel(planId) transaction from the subscriber's own
   * wallet -- belt and suspenders: even if the keeper is compromised or down, the contract itself will then
   * refuse to settle any further charge for this subscription.
   */
  async cancel(subscriptionId: string, opts: { onchain?: boolean } = {}): Promise<SubscriptionView> {
    const provider = this.requireProvider();
    const subscriber = await this.connect();
    const signature = (await (provider.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({
      method: "personal_sign",
      params: [cancelMessage(subscriptionId), subscriber],
    })) as `0x${string}`;
    const result = await this.client.cancelWithSignature(subscriptionId, signature);

    if (opts.onchain) {
      const [config, detail] = await Promise.all([this.client.getConfig(), this.client.getSubscription(subscriptionId)]);
      try {
        await cancelOnchain({ provider, chain: resolveChain(config.chainId), tabline: config.tabline, rpcUrl: this.rpcUrl, planId: BigInt(detail.planId) });
      } catch (e) {
        throw new TablineError("onchain_cancel_failed", `Cancelled with the billing service, but the on-chain transaction failed: ${(e as Error).message}`);
      }
    }
    return result;
  }

  /**
   * Creates a new plan directly on Tabline from the connected (merchant) wallet -- a real on-chain transaction.
   * The keeper address is filled in automatically from the running keeper's own config, since a plan only
   * makes sense paired with the keeper that will actually operate it.
   */
  async createPlan(args: { amount: bigint; periodSeconds: number; kind: "fixed" | "metered"; payout: Address; token: Address }): Promise<string> {
    const provider = this.requireProvider();
    const config = await this.client.getConfig();
    return createPlanOnchain({
      provider,
      chain: resolveChain(config.chainId),
      tabline: config.tabline,
      rpcUrl: this.rpcUrl,
      token: args.token,
      payout: args.payout,
      keeper: config.keeperAddress,
      amount: args.amount,
      period: args.kind === "fixed" ? args.periodSeconds : 0,
      kind: args.kind,
    });
  }
}
