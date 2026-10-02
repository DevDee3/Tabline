# Tabline

Recurring and pay-per-use stablecoin payments for wallets, on Arbitrum. Instead of an unlimited token approval,
a user opens a **tab**: a scoped, revocable spending permission (ERC-7715 / ERC-7710) capped per period. Tabline
is the merchant-side billing layer on top of that permission -- plans, verified settlement, idempotent retries,
no back-billing, subscriber cancel -- and never custodies funds. Built for the Arbitrum Open House Singapore
buildathon.

## Repo layout

| Path | What it is | Status |
| --- | --- | --- |
| `src/Tabline.sol`, `test/`, `script/` | The on-chain plan registry + settlement ledger (Foundry) | **29/29 tests passing** |
| `keeper/` | The billing engine + HTTP API a merchant runs (Node/TS) | **38/38 tests passing**, real Anvil chain |
| `sdk/` | `@tabline/sdk` -- browser client: wallet permission flow, checkout widget, on-chain writes | **17/17 tests passing** |
| `app/` | The reference frontend: Shop (checkout), Tabs (subscriber view), Merchant (dashboard), Agent (pay-per-call demo) | **7/7 smoke tests passing**, builds clean |
| `spike/` | The Sep-22 wallet-permission spike (see below) | Typechecks; **live-wallet run not yet executed** |
| `scripts/dev-local.sh` | One-command local stack: anvil + deploy + seed two demo plans + keeper API | Written; **standalone end-to-end run blocked by sandbox instability**, see note below |

**91/91 automated tests pass.** The one thing I have not personally watched succeed is `scripts/dev-local.sh`
running start-to-finish as a long-lived standalone process outside of a test harness -- every attempt to keep a
manually-launched `anvil` alive across tool calls in my dev sandbox triggered a full environment reset (process
table and `/tmp` wiped, `/home/claude` untouched). The exact same anvil-backed integration path works reliably
*inside* `keeper`'s vitest harness (that's what the 38/38 number above actually exercises), so the underlying
code is proven; only the convenience script's own unattended execution isn't. If you hit trouble with
`dev-local.sh`, run the pieces by hand (anvil, then the `cast send` calls, then `cd keeper && npm start`)
and it should behave identically to the test harness.

## Quickstart

```bash
# contracts
forge test

# keeper (billing engine + API) -- standalone package, its own install
cd keeper && npm install && npm test

# sdk + app share an npm workspace rooted at the repo root (so @tabline/sdk resolves into app/node_modules
# as a normal symlinked package) -- install once from here:
npm install
cd sdk && npm test
cd ../app && npm run dev
# open the printed localhost URL; it defaults to a fully simulated backend (see app/src/lib/demo.ts)
# so Shop/Tabs/Merchant/Agent all work with no wallet, no keeper, no chain.

# app against a REAL local keeper instead of the simulation:
./scripts/dev-local.sh                                              # terminal 1
cd app && NEXT_PUBLIC_KEEPER_URL=http://localhost:8787 npm run dev   # terminal 2
```

## Production deployment requirements

The local quickstart is a testnet/development setup. A production deployment must use:

- `CHAIN=arbitrum` with an explicit production RPC and production USDC/token address.
- `REDEEM_MODE=smart-account` plus a production bundler; EOA sequential settlement is rejected by the keeper in production.
- `DATABASE_URL=sqlite:./tabline.db` (or a managed database adapter), durable backups, and a persistent volume.
- `MERCHANT_ADDRESSES` containing the merchant wallet allowlist. Merchant access uses a wallet signature and an HTTP-only session cookie; no API key is placed in the browser.
- `COOKIE_SECURE=true`, HTTPS, explicit `CORS_ORIGIN`, a strong `WEBHOOK_SECRET`, isolated keeper keys, and RPC failover through `RPC_URLS`.
- Monitoring of `/health`, `/ready`, and `/metrics`, plus alerts for failed settlement cycles and webhook delivery failures.

Do not reuse Arbitrum Sepolia plan IDs or testnet token addresses in production. Create production plans after deployment and set `NEXT_PUBLIC_PLAN_FIXED`, `NEXT_PUBLIC_PLAN_METERED`, and `NEXT_PUBLIC_TOKEN_ADDRESS` in the frontend deployment.

## How a charge actually happens

1. `Tabline.snapshot(planId)` records the payout address's current token balance.
2. The keeper redeems the subscriber's granted permission, which moves tokens from the subscriber's account to
   the payout address.
3. `Tabline.settle(planId, subscriber, chargeKey, amount)` verifies the balance rose by exactly `amount`,
   enforces the billing period, records the charge, and emits `Charged`. A `chargeKey` makes every charge
   idempotent, so retries can never double-record; missed periods are skipped, never back-billed.

Design notes worth knowing:
- Only a plan's merchant or its keeper may snapshot/settle -- otherwise anyone could forge a receipt by donating
  tokens to the payout address.
- The balance-delta check proves funds arrived, not *which* account paid; the DelegationManager's own redemption
  event is the real source of truth for the payer.
- In MetaMask's own example the redeemer chooses the transfer recipient, so a compromised keeper key can move up
  to one period's allowance elsewhere. Keep keeper keys isolated and permissions small (see `keeper/README.md`).
- The keeper's EOA-sequential redeemer mode is *not* atomic (see `keeper/src/redeemers.ts`'s `PartialChargeError`
  handling); the preferred production mode is the smart-account batch redeemer, which makes snapshot, redeem, and
  settle one atomic user operation.

## Sep 22 spike

Before building the keeper and app, `spike/` answered the load-bearing question: does `erc20-token-periodic`
actually work end-to-end on Arbitrum through a real wallet? It typechecks against the live
`@metamask/smart-accounts-kit` SDK and is ready to run, but I have not yet executed it against a real MetaMask
wallet -- see `spike/README.md`-equivalent instructions in the top of `spike/src/main.ts` and
`spike/keeper/redeem-eoa.ts` for exact steps (check support -> grant a permission -> redeem -> attempt an
over-limit redemption and confirm it's rejected).

## What's real vs. simulated in the app

`app/` picks a backend at load time (`app/src/lib/env.ts`): with no `NEXT_PUBLIC_KEEPER_URL` set (or `?demo` in the
URL) it uses `DemoBackend`, a fully in-memory simulation with seeded history, so every page works with no wallet
and no server. Set `NEXT_PUBLIC_KEEPER_URL` to point it at a real running `keeper` instead -- `HttpBackend` then talks
to the real API, and wallet actions (opening a tab, cancelling, creating a plan) go through the real SDK's
`Tabline` class, which signs with the connected wallet and submits real transactions / permission requests.
