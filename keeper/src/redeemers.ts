import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  type Address,
  type Chain as ViemChain,
  type Hex,
} from "viem";
import { createBundlerClient } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";
import {
  Implementation,
  toMetaMaskSmartAccount,
} from "@metamask/smart-accounts-kit";
import { erc7710BundlerActions, erc7710WalletActions } from "@metamask/smart-accounts-kit/actions";
import { tablineAbi } from "./abi";
import type { Plan, StoredGrant } from "./types";

export interface ChargeRequest {
  planId: bigint;
  subscriber: Address;
  chargeKey: Hex;
  amount: bigint;
  plan: Plan;
  grant: StoredGrant;
}

/**
 * A Redeemer executes one full charge: snapshot -> redeem the subscriber's permission -> settle.
 * Resolves with the settle transaction hash, or throws if ANY step fails (nothing is recorded as paid then).
 */
export interface Redeemer {
  readonly mode: string;
  /** Address the subscriber's permission must be granted to (the delegate / session account). */
  readonly keeperAddress: Address;
  charge(req: ChargeRequest): Promise<Hex>;
}

/**
 * Thrown when funds MAY have moved but no receipt was recorded (sequential mode only). The engine must not
 * auto-retry after this: another redeem could pull a second payment. It parks the subscription for review.
 */
export class PartialChargeError extends Error {
  constructor(
    readonly redeemTx: Hex,
    readonly reason: string,
  ) {
    super(`partial charge: redeem ${redeemTx} succeeded but settle failed (${reason})`);
    this.name = "PartialChargeError";
  }
}

const snapshotData = (planId: bigint) =>
  encodeFunctionData({ abi: tablineAbi, functionName: "snapshot", args: [planId] });

const settleData = (r: ChargeRequest) =>
  encodeFunctionData({
    abi: tablineAbi,
    functionName: "settle",
    args: [r.planId, r.subscriber, r.chargeKey, r.amount],
  });

const transferData = (r: ChargeRequest) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [r.plan.payout, r.amount] });

export interface RedeemerConfig {
  chain: ViemChain;
  rpcUrl?: string;
  keeperPrivateKey: Hex;
  tabline: Address;
}

/**
 * PREFERRED mode. The keeper is a MetaMask smart account; snapshot, delegated transfer and settle are ONE user
 * operation, so a failed step reverts everything and no charge is half-recorded.
 *
 * UNVERIFIED against a live bundler: whether a mixed batch (plain calls + one delegated call) is accepted by
 * `sendUserOperationWithDelegation`. That is spike question #2. If it is rejected, use the EOA sequential mode.
 */
export async function createSmartAccountRedeemer(cfg: RedeemerConfig & { bundlerUrl: string }): Promise<Redeemer> {
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain: cfg.chain, transport });
  const owner = privateKeyToAccount(cfg.keeperPrivateKey);

  const sessionAccount = await toMetaMaskSmartAccount({
    client: publicClient,
    implementation: Implementation.Hybrid,
    deployParams: [owner.address, [], [], []],
    deploySalt: "0x",
    signer: { account: owner },
  });

async function feeOverrides(publicClient: ReturnType<typeof createPublicClient>) {
  const block = await publicClient.getBlock();
  if (block.baseFeePerGas === null) return {};
  const priority = await publicClient.estimateMaxPriorityFeePerGas().catch(() => 1_000_000n);
  return { maxFeePerGas: block.baseFeePerGas * 2n + priority, maxPriorityFeePerGas: priority };
}

  const bundlerClient = createBundlerClient({
    client: publicClient,
    transport: http(cfg.bundlerUrl),
  }).extend(erc7710BundlerActions());

  return {
    mode: "smart-account-batch",
    keeperAddress: sessionAccount.address,
    async charge(r) {
      const fees = await feeOverrides(publicClient);
      const userOpHash = await bundlerClient.sendUserOperationWithDelegation({
        publicClient,
        account: sessionAccount,
        calls: [
          { to: cfg.tabline, data: snapshotData(r.planId) },
          {
            to: r.grant.tokenAddress,
            data: transferData(r),
            permissionContext: r.grant.context,
            delegationManager: r.grant.delegationManager,
          },
          { to: cfg.tabline, data: settleData(r) },
        ],
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: userOpHash });
      if (!receipt.success) throw new Error(`user operation ${userOpHash} reverted`);
      return receipt.receipt.transactionHash;
    },
  };
}

/**
 * FALLBACK mode. The keeper is a plain EOA and sends three transactions in sequence. It works with any RPC and needs
 * no bundler, but it is NOT atomic. If the redeem succeeds and the settle then fails, funds moved without a receipt.
 * That case throws PartialChargeError and the engine parks the subscription for review instead of retrying, because
 * a blind retry could pull a second payment if the wallet allowance still has room. Grant permissions with
 * periodAmount == plan price (the SDK does) to keep that window small. Also: a stray deposit to the payout address
 * between snapshot and settle could satisfy the balance check, which is why smart-account mode is preferred.
 */
export function createEoaSequentialRedeemer(cfg: RedeemerConfig): Redeemer {
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain: cfg.chain, transport });
  const account = privateKeyToAccount(cfg.keeperPrivateKey);
  const walletClient = createWalletClient({ account, chain: cfg.chain, transport }).extend(erc7710WalletActions());

  const wait = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  };

  return {
    mode: "eoa-sequential",
    keeperAddress: account.address,
    async charge(r) {
      await wait(
        await walletClient.sendTransaction({ account, chain: cfg.chain, to: cfg.tabline, data: snapshotData(r.planId) }),
      );
      const redeemHash = await walletClient.sendTransactionWithDelegation({
          account,
          chain: cfg.chain,
          to: r.grant.tokenAddress,
          data: transferData(r),
          permissionContext: r.grant.context,
          delegationManager: r.grant.delegationManager,
        });
      await wait(redeemHash);
      const redeemTx = redeemHash;
      try {
        const settle = await wait(
          await walletClient.sendTransaction({ account, chain: cfg.chain, to: cfg.tabline, data: settleData(r) }),
        );
        return settle.transactionHash;
      } catch (e) {
        throw new PartialChargeError(redeemTx, (e as Error).message.split("\n")[0]);
      }
    },
  };
}
