import { createPublicClient, fallback, http, isAddress, type Address, type Hex } from "viem";
import { arbitrum, arbitrumSepolia, foundry } from "viem/chains";
import { createApi } from "./api";
import { Chain } from "./chain";
import { Engine } from "./engine";
import { createEoaSequentialRedeemer, createSmartAccountRedeemer, type Redeemer } from "./redeemers";
import { Store } from "./store";
import { Webhooks } from "./webhooks";

const CHAINS = { arbitrum, arbitrumSepolia, foundry } as const;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see keeper/.env.example)`);
  return v;
}

function positiveInt(name: string, fallback: number, max?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    const range = max === undefined ? "a positive integer" : `an integer from 1 to ${max}`;
    throw new Error(`${name} must be ${range}`);
  }
  return value;
}

async function main() {
  const chainName = (process.env.CHAIN ?? "arbitrumSepolia") as keyof typeof CHAINS;
  const chain = CHAINS[chainName];
  if (!chain) throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);

  const rpcUrl = process.env.RPC_URL;
  const rpcUrls = [rpcUrl, ...(process.env.RPC_URLS ?? "").split(",")].map((x) => x?.trim()).filter(Boolean) as string[];
  if (process.env.NODE_ENV === "production" && rpcUrls.length === 0) throw new Error("RPC_URL or RPC_URLS is required in production");
  const tabline = need("TABLINE_ADDRESS") as Address;
  const keeperPrivateKey = need("KEEPER_PK") as Hex;

  const bundlerUrl = process.env.BUNDLER_URL;
  const merchantAddresses = (process.env.MERCHANT_ADDRESSES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (merchantAddresses.some((address) => !isAddress(address))) throw new Error("MERCHANT_ADDRESSES contains an invalid wallet address");
  const requestedMode = process.env.REDEEM_MODE;
  if (requestedMode && requestedMode !== "eoa" && requestedMode !== "smart-account") {
    throw new Error('REDEEM_MODE must be "eoa" or "smart-account"');
  }
  const mode = requestedMode ?? (bundlerUrl ? "smart-account" : "eoa");
  if (process.env.NODE_ENV === "production") {
    const testnetDeployment = process.env.ALLOW_TESTNET_DEPLOYMENT === "true";
    if (chainName !== "arbitrum" && !(testnetDeployment && chainName === "arbitrumSepolia")) {
      throw new Error("production keeper must use CHAIN=arbitrum, or explicitly set ALLOW_TESTNET_DEPLOYMENT=true for Arbitrum Sepolia");
    }
    if (!testnetDeployment && (mode !== "smart-account" || !bundlerUrl)) {
      throw new Error("production keeper requires REDEEM_MODE=smart-account and BUNDLER_URL");
    }
    if (process.env.COOKIE_SECURE !== "true") throw new Error("production keeper requires COOKIE_SECURE=true");
    if (!process.env.WEBHOOK_SECRET) throw new Error("production keeper requires WEBHOOK_SECRET");
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error("production keeper requires SESSION_SECRET with at least 32 characters");
    if (!process.env.MERCHANT_ADDRESSES?.trim()) throw new Error("production keeper requires MERCHANT_ADDRESSES");
    if ((process.env.CORS_ORIGIN ?? "").includes("*")) throw new Error("production CORS_ORIGIN must list explicit origins");
  }
  const redeemerRpcUrl = rpcUrls[0] ?? rpcUrl;
  const redeemer: Redeemer =
    mode === "smart-account"
      ? await createSmartAccountRedeemer({ chain, rpcUrl: redeemerRpcUrl, keeperPrivateKey, tabline, bundlerUrl: bundlerUrl ?? need("BUNDLER_URL") })
      : createEoaSequentialRedeemer({ chain, rpcUrl: redeemerRpcUrl, keeperPrivateKey, tabline });

  const transport = rpcUrls.length > 1 ? fallback(rpcUrls.map((url) => http(url))) : http(redeemerRpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const store = new Store(process.env.DATABASE_URL || process.env.DATA_FILE || "sqlite:./tabline.db");
  const webhooks = new Webhooks(store, { url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET });
  const chainReader = new Chain(publicClient as never, tabline);
  const engine = new Engine({ chain: chainReader, store, redeemer, webhooks });

  const server = createApi({
    chain: chainReader,
    store,
    engine,
    webhooks,
    publicClient: publicClient as never,
    keeperAddress: redeemer.keeperAddress,
    chainId: chain.id,
    corsOrigin: process.env.CORS_ORIGIN,
    merchantAddresses,
    sessionSecret: process.env.SESSION_SECRET,
  });

  const port = positiveInt("PORT", 8787, 65535);
  server.listen(port, () => {
    console.log(`Tabline keeper on :${port} chain=${chain.name} mode=${redeemer.mode}`);
    console.log(`Grant permissions to (keeper / delegate): ${redeemer.keeperAddress}`);
  });
  engine.start(positiveInt("CYCLE_SECONDS", 30) * 1000);
  const shutdown = (signal: string) => {
    console.log(`keeper shutting down (${signal})`);
    engine.stop();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
