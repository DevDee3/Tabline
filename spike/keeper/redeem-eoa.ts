/**
 * SPIKE keeper (EOA session account). Proves the redeem half of the loop:
 *   permission granted in MetaMask  ->  keeper redeems a USDC transfer via the DelegationManager.
 *
 * Usage:
 *   export KEEPER_PK=0x...            # keeper private key (fund it with a little ETH for gas)
 *   export PAYOUT=0x...               # merchant payout address (receives the USDC)
 *   export NETWORK=arbitrumSepolia    # or: arbitrum
 *   export RPC_URL=https://...        # optional, defaults to the chain's public RPC
 *   npm run redeem -- address         # prints the keeper address to paste into the web page
 *   npm run redeem -- charge 1        # redeem a 1 USDC transfer using ./grant.json
 *   npm run redeem -- overspend       # try to pull MORE than one period allows (should revert)
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, formatUnits, http, parseUnits } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc7710WalletActions } from "@metamask/smart-accounts-kit/actions";
import { NETWORKS, type NetworkKey } from "../src/config";

interface GrantedPermission {
  chainId: number | string;
  context: Hex;
  delegationManager: Address;
  dependencies?: unknown[];
  permission: { type: string; data: { periodAmount: string | number; periodDuration: number } };
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const network = (process.env.NETWORK ?? "arbitrumSepolia") as NetworkKey;
const net = NETWORKS[network];
if (!net) throw new Error(`Unknown NETWORK "${network}". Use arbitrumSepolia or arbitrum.`);

const account = privateKeyToAccount(need("KEEPER_PK") as Hex);
const transport = http(process.env.RPC_URL);

const publicClient = createPublicClient({ chain: net.chain, transport });
const walletClient = createWalletClient({ account, chain: net.chain, transport }).extend(erc7710WalletActions());

function loadGrant(): GrantedPermission {
  const raw = JSON.parse(readFileSync(new URL("../grant.json", import.meta.url), "utf8")) as GrantedPermission[];
  const g = raw.find((p) => Number(p.chainId) === net.chain.id);
  if (!g) throw new Error(`grant.json has no permission for chain ${net.chain.id}`);
  if (g.dependencies && g.dependencies.length > 0) {
    console.warn("WARNING: grant has dependencies (account deployment) that this script does not handle yet.");
  }
  return g;
}

async function usdcBalance(who: Address): Promise<bigint> {
  return publicClient.readContract({ address: net.usdc, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

async function redeemTransfer(grant: GrantedPermission, payout: Address, amount: bigint): Promise<Hex> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [payout, amount] });
  return walletClient.sendTransactionWithDelegation({
    account,
    chain: net.chain,
    to: net.usdc,
    data,
    permissionContext: grant.context,
    delegationManager: grant.delegationManager,
  });
}

async function main() {
  const mode = process.argv[2] ?? "charge";

  if (mode === "address") {
    console.log(account.address);
    return;
  }

  const grant = loadGrant();
  const payout = need("PAYOUT") as Address;
  console.log(`network=${network} keeper=${account.address} delegationManager=${grant.delegationManager}`);

  if (mode === "overspend") {
    const periodAmount = BigInt(grant.permission.data.periodAmount);
    const tooMuch = periodAmount + 1n;
    console.log(`Attempting ${formatUnits(tooMuch, 6)} USDC (limit per period: ${formatUnits(periodAmount, 6)}). Expect a revert.`);
    try {
      const hash = await redeemTransfer(grant, payout, tooMuch);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log(`UNEXPECTED: tx mined with status=${receipt.status}. The limit was NOT enforced as assumed.`);
    } catch (e) {
      console.log(`PASS: over-limit redemption rejected. ${(e as Error).message.split("\n")[0]}`);
    }
    return;
  }

  const amount = parseUnits(process.argv[3] ?? "1", 6);
  const before = await usdcBalance(payout);
  const hash = await redeemTransfer(grant, payout, amount);
  console.log(`redeem tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await usdcBalance(payout);
  console.log(`status=${receipt.status} payout delta=${formatUnits(after - before, 6)} USDC`);
  console.log(after - before === amount ? "PASS: payout received exactly the requested amount." : "CHECK: delta differs.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
