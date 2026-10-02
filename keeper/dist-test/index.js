"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const viem_1 = require("viem");
const chains_1 = require("viem/chains");
const api_1 = require("./api");
const chain_1 = require("./chain");
const engine_1 = require("./engine");
const redeemers_1 = require("./redeemers");
const store_1 = require("./store");
const webhooks_1 = require("./webhooks");
const CHAINS = { arbitrum: chains_1.arbitrum, arbitrumSepolia: chains_1.arbitrumSepolia, foundry: chains_1.foundry };
function need(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env var ${name} (see keeper/.env.example)`);
    return v;
}
function positiveInt(name, fallback, max) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0 || (max !== undefined && value > max)) {
        const range = max === undefined ? "a positive integer" : `an integer from 1 to ${max}`;
        throw new Error(`${name} must be ${range}`);
    }
    return value;
}
async function main() {
    const chainName = (process.env.CHAIN ?? "arbitrumSepolia");
    const chain = CHAINS[chainName];
    if (!chain)
        throw new Error(`CHAIN must be one of ${Object.keys(CHAINS).join(", ")}`);
    const rpcUrl = process.env.RPC_URL;
    const tabline = need("TABLINE_ADDRESS");
    const keeperPrivateKey = need("KEEPER_PK");
    const merchantApiKey = need("MERCHANT_API_KEY");
    if (merchantApiKey.length < 16)
        throw new Error("MERCHANT_API_KEY must be at least 16 characters");
    const bundlerUrl = process.env.BUNDLER_URL;
    const requestedMode = process.env.REDEEM_MODE;
    if (requestedMode && requestedMode !== "eoa" && requestedMode !== "smart-account") {
        throw new Error('REDEEM_MODE must be "eoa" or "smart-account"');
    }
    const mode = requestedMode ?? (bundlerUrl ? "smart-account" : "eoa");
    const redeemer = mode === "smart-account"
        ? await (0, redeemers_1.createSmartAccountRedeemer)({ chain, rpcUrl, keeperPrivateKey, tabline, bundlerUrl: bundlerUrl ?? need("BUNDLER_URL") })
        : (0, redeemers_1.createEoaSequentialRedeemer)({ chain, rpcUrl, keeperPrivateKey, tabline });
    const publicClient = (0, viem_1.createPublicClient)({ chain, transport: (0, viem_1.http)(rpcUrl) });
    const store = new store_1.Store(process.env.DATA_FILE ?? "./tabline-data.json");
    const webhooks = new webhooks_1.Webhooks(store, { url: process.env.WEBHOOK_URL, secret: process.env.WEBHOOK_SECRET });
    const chainReader = new chain_1.Chain(publicClient, tabline);
    const engine = new engine_1.Engine({ chain: chainReader, store, redeemer, webhooks });
    const server = (0, api_1.createApi)({
        chain: chainReader,
        store,
        engine,
        webhooks,
        publicClient: publicClient,
        keeperAddress: redeemer.keeperAddress,
        chainId: chain.id,
        merchantApiKey,
        corsOrigin: process.env.CORS_ORIGIN,
    });
    const port = positiveInt("PORT", 8787, 65535);
    server.listen(port, () => {
        console.log(`Tabline keeper on :${port} chain=${chain.name} mode=${redeemer.mode}`);
        console.log(`Grant permissions to (keeper / delegate): ${redeemer.keeperAddress}`);
    });
    engine.start(positiveInt("CYCLE_SECONDS", 30) * 1000);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
