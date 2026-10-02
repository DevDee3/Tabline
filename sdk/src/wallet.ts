import { createWalletClient, custom, type Address, type Chain, type EIP1193Provider } from "viem";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";

export interface RequestTabArgs {
  /** The injected wallet provider, e.g. window.ethereum. */
  provider: EIP1193Provider;
  chain: Chain;
  /** The keeper/delegate address from TablineClient.getConfig().keeperAddress. */
  keeperAddress: Address;
  tokenAddress: Address;
  /** Max amount chargeable per period, in the token's base units (e.g. USDC has 6 decimals). */
  periodAmount: bigint;
  /** Must be >= the plan's billing period for a fixed plan. Any positive window for metered. */
  periodDurationSeconds: number;
  /** Unix seconds. Tabline's keeper refuses permissions without an expiry, so this is required. */
  expiry: number;
  justification?: string;
}

/**
 * Requests a scoped, periodic ERC-20 spending permission (ERC-7715) from the user's wallet and returns the raw
 * grant array exactly as the wallet returned it -- pass this straight to TablineClient.subscribe(). Requires
 * MetaMask 13.23.0+ with the account upgraded to a smart account.
 */
export async function requestTab(args: RequestTabArgs) {
  const walletClient = createWalletClient({ chain: args.chain, transport: custom(args.provider) }).extend(erc7715ProviderActions());
  const request = () => walletClient.requestExecutionPermissions([
    {
      chainId: args.chain.id,
      expiry: args.expiry,
      to: args.keeperAddress,
      permission: {
        type: "erc20-token-periodic",
        data: {
          tokenAddress: args.tokenAddress,
          periodAmount: args.periodAmount,
          periodDuration: args.periodDurationSeconds,
          justification: args.justification ?? "Recurring payment via Tabline",
        },
        isAdjustmentAllowed: true,
      },
    },
  ]);
  try {
    return await request();
  } catch (error) {
    // Some RPCs return a fee estimate that is stale by the time MetaMask submits the
    // permission transaction. A single retry lets MetaMask refresh its fee data without
    // masking genuine wallet rejection or permission errors.
    const message = error instanceof Error ? error.message : String(error);
    if (!/max fee per gas less than block base fee|underpriced/i.test(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return request();
  }
}

/** True if the connected wallet reports support for the permission type Tabline needs, on this chain. */
export async function walletSupportsTabline(provider: EIP1193Provider, chainId: number): Promise<boolean> {
  const walletClient = createWalletClient({ transport: custom(provider) }).extend(erc7715ProviderActions());
  const supported = await walletClient.getSupportedExecutionPermissions();
  const entry = (supported as Record<string, { chainIds: (string | number)[] } | undefined>)["erc20-token-periodic"];
  const hex = `0x${chainId.toString(16)}`;
  return entry?.chainIds.some((c) => String(c).toLowerCase() === hex || Number(c) === chainId) ?? false;
}
