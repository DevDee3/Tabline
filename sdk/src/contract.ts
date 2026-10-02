import { createPublicClient, createWalletClient, custom, http, type Address, type Chain, type EIP1193Provider, type Hex } from "viem";

/** Just the fragments the browser SDK needs to write to Tabline directly (plan creation, on-chain cancel). */
export const tablineWriteAbi = [
  {
    type: "function",
    name: "createPlan",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "payout", type: "address" },
      { name: "keeper", type: "address" },
      { name: "amount", type: "uint96" },
      { name: "period", type: "uint32" },
      { name: "kind", type: "uint8" },
    ],
    outputs: [{ name: "planId", type: "uint256" }],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [{ name: "planId", type: "uint256" }],
    outputs: [],
  },
  {
    type: "event",
    name: "PlanCreated",
    inputs: [
      { name: "planId", type: "uint256", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "payout", type: "address", indexed: false },
      { name: "keeper", type: "address", indexed: false },
      { name: "amount", type: "uint96", indexed: false },
      { name: "period", type: "uint32", indexed: false },
      { name: "kind", type: "uint8", indexed: false },
    ],
  },
] as const;

export const PLAN_KIND = { fixed: 0, metered: 1 } as const;

/**
 * Some RPCs return a fee estimate that is already stale by the time MetaMask
 * submits the transaction. Build a conservative EIP-1559 fee from the latest
 * block so the max fee remains above the current base fee.
 */
async function currentFeeOverrides(publicClient: ReturnType<typeof createPublicClient>) {
  const block = await publicClient.getBlock();
  if (block.baseFeePerGas === null) return {};
  const priority = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 1_000_000n);
  return {
    maxPriorityFeePerGas: priority,
    maxFeePerGas: block.baseFeePerGas * 2n + priority,
  };
}

/**
 * Calls Tabline.createPlan from the connected wallet and returns the new plan's id, read back from the
 * PlanCreated event rather than guessed, so it is correct even if other plans were created concurrently.
 */
export async function createPlanOnchain(args: {
  provider: EIP1193Provider;
  chain: Chain;
  tabline: Address;
  rpcUrl?: string;
  token: Address;
  payout: Address;
  keeper: Address;
  amount: bigint;
  period: number;
  kind: "fixed" | "metered";
}): Promise<string> {
  const accounts = (await args.provider.request({ method: "eth_requestAccounts" })) as Address[];
  const account = accounts[0];
  if (!account) throw new Error("No account was authorized in the wallet.");

  const walletClient = createWalletClient({ account, chain: args.chain, transport: custom(args.provider) });
  const publicClient = createPublicClient({ chain: args.chain, transport: args.rpcUrl ? http(args.rpcUrl) : custom(args.provider) });
  const feeOverrides = await currentFeeOverrides(publicClient);

  const hash = await walletClient.writeContract({
    address: args.tabline,
    abi: tablineWriteAbi,
    functionName: "createPlan",
    args: [args.token, args.payout, args.keeper, args.amount, args.period, PLAN_KIND[args.kind]],
    ...feeOverrides,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== args.tabline.toLowerCase()) continue;
    // PlanCreated's first indexed topic (after the event signature) is the planId.
    if (log.topics.length >= 2 && log.topics[1]) {
      return BigInt(log.topics[1] as Hex).toString();
    }
  }
  throw new Error("Plan was created but its id could not be read back from the transaction receipt.");
}

/** Calls Tabline.cancel(planId) from the connected wallet -- a real on-chain transaction, not just an API call. */
export async function cancelOnchain(args: {
  provider: EIP1193Provider;
  chain: Chain;
  tabline: Address;
  rpcUrl?: string;
  planId: bigint;
}): Promise<Hex> {
  const accounts = (await args.provider.request({ method: "eth_requestAccounts" })) as Address[];
  const account = accounts[0];
  if (!account) throw new Error("No account was authorized in the wallet.");

  const walletClient = createWalletClient({ account, chain: args.chain, transport: custom(args.provider) });
  const publicClient = createPublicClient({ chain: args.chain, transport: args.rpcUrl ? http(args.rpcUrl) : custom(args.provider) });
  const feeOverrides = await currentFeeOverrides(publicClient);

  const hash = await walletClient.writeContract({ address: args.tabline, abi: tablineWriteAbi, functionName: "cancel", args: [args.planId], ...feeOverrides });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}
