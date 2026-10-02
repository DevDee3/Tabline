# Tabline keeper

The keeper is the merchant-side billing worker and HTTP API. It reads subscription permissions, records usage, and settles eligible charges on-chain.

## Setup

Install dependencies and copy the environment template:

```bash
cd keeper
npm install
cp .env.example .env
```

Fill in the values in `.env`:

- `CHAIN`: `arbitrumSepolia`, `arbitrum`, or `foundry`.
- `RPC_URL`: RPC endpoint. Leave empty when the selected viem chain default is suitable.
- `TABLINE_ADDRESS`: deployed Tabline contract address.
- `KEEPER_PK`: isolated keeper private key. Never expose this to the browser or commit it.
- `DATABASE_URL`: SQLite database URL such as `sqlite:./tabline.db`; use a persistent volume and backups in production.
- `MERCHANT_ADDRESSES`: comma-separated merchant wallet allowlist. Production startup requires it.
- `BUNDLER_URL`: set this to use the preferred atomic smart-account mode; leave empty for EOA sequential mode.
- `CORS_ORIGIN`: the frontend origin allowed to call the API. Set this explicitly for deployed or embedded use.
- `RPC_URLS`: optional comma-separated read-RPC failover list.
- `COOKIE_SECURE`: set `true` when serving through HTTPS.

Start the keeper from the `keeper` directory:

```bash
npm start
```

The start script loads `keeper/.env` automatically. The API listens on `PORT` (default `8787`) and runs billing cycles every `CYCLE_SECONDS` (default `30`). It applies a process-local limit of 120 non-health requests per minute per client address. Put a shared rate limiter or gateway in front of the keeper before running multiple instances.

## Modes

`REDEEM_MODE=smart-account` uses the bundler and makes snapshot, redemption, and settlement atomic. This is the preferred production mode.

`REDEEM_MODE=eoa` sends the operations sequentially. It works without a bundler but is not atomic; keep the keeper key funded and isolated.

## Useful endpoints

- `GET /health` — process and chain health information.
- `GET /v1/config` — public chain and contract configuration.
- `GET /v1/plans/:id` — public plan details.
- `GET /v1/subscriptions?subscriber=0x...` — subscriptions for an account.
- `POST /v1/subscriptions` — register a wallet permission.
- `POST /v1/subscriptions/:id/cancel` — cancel a subscription.

No API key is required. Merchant-wide reads and mutations require a wallet session. Do not expose `KEEPER_PK` in a client bundle.
