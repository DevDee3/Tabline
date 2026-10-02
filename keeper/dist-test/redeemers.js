"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PartialChargeError = void 0;
exports.createSmartAccountRedeemer = createSmartAccountRedeemer;
exports.createEoaSequentialRedeemer = createEoaSequentialRedeemer;
const viem_1 = require("viem");
const account_abstraction_1 = require("viem/account-abstraction");
const accounts_1 = require("viem/accounts");
const smart_accounts_kit_1 = require("@metamask/smart-accounts-kit");
const actions_1 = require("@metamask/smart-accounts-kit/actions");
const abi_1 = require("./abi");
/**
 * Thrown when funds MAY have moved but no receipt was recorded (sequential mode only). The engine must not
 * auto-retry after this: another redeem could pull a second payment. It parks the subscription for review.
 */
class PartialChargeError extends Error {
    redeemTx;
    reason;
    constructor(redeemTx, reason) {
        super(`partial charge: redeem ${redeemTx} succeeded but settle failed (${reason})`);
        this.redeemTx = redeemTx;
        this.reason = reason;
        this.name = "PartialChargeError";
    }
}
exports.PartialChargeError = PartialChargeError;
const snapshotData = (planId) => (0, viem_1.encodeFunctionData)({ abi: abi_1.tablineAbi, functionName: "snapshot", args: [planId] });
const settleData = (r) => (0, viem_1.encodeFunctionData)({
    abi: abi_1.tablineAbi,
    functionName: "settle",
    args: [r.planId, r.subscriber, r.chargeKey, r.amount],
});
const transferData = (r) => (0, viem_1.encodeFunctionData)({ abi: viem_1.erc20Abi, functionName: "transfer", args: [r.plan.payout, r.amount] });
/**
 * PREFERRED mode. The keeper is a MetaMask smart account; snapshot, delegated transfer and settle are ONE user
 * operation, so a failed step reverts everything and no charge is half-recorded.
 *
 * UNVERIFIED against a live bundler: whether a mixed batch (plain calls + one delegated call) is accepted by
 * `sendUserOperationWithDelegation`. That is spike question #2. If it is rejected, use the EOA sequential mode.
 */
async function createSmartAccountRedeemer(cfg) {
    const transport = (0, viem_1.http)(cfg.rpcUrl);
    const publicClient = (0, viem_1.createPublicClient)({ chain: cfg.chain, transport });
    const owner = (0, accounts_1.privateKeyToAccount)(cfg.keeperPrivateKey);
    const sessionAccount = await (0, smart_accounts_kit_1.toMetaMaskSmartAccount)({
        client: publicClient,
        implementation: smart_accounts_kit_1.Implementation.Hybrid,
        deployParams: [owner.address, [], [], []],
        deploySalt: "0x",
        signer: { account: owner },
    });
    const bundlerClient = (0, account_abstraction_1.createBundlerClient)({
        client: publicClient,
        transport: (0, viem_1.http)(cfg.bundlerUrl),
    }).extend((0, actions_1.erc7710BundlerActions)());
    return {
        mode: "smart-account-batch",
        keeperAddress: sessionAccount.address,
        async charge(r) {
            const fees = await publicClient.estimateFeesPerGas();
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
            if (!receipt.success)
                throw new Error(`user operation ${userOpHash} reverted`);
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
function createEoaSequentialRedeemer(cfg) {
    const transport = (0, viem_1.http)(cfg.rpcUrl);
    const publicClient = (0, viem_1.createPublicClient)({ chain: cfg.chain, transport });
    const account = (0, accounts_1.privateKeyToAccount)(cfg.keeperPrivateKey);
    const walletClient = (0, viem_1.createWalletClient)({ account, chain: cfg.chain, transport }).extend((0, actions_1.erc7710WalletActions)());
    const wait = async (hash) => {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success")
            throw new Error(`transaction ${hash} reverted`);
        return receipt;
    };
    return {
        mode: "eoa-sequential",
        keeperAddress: account.address,
        async charge(r) {
            await wait(await walletClient.sendTransaction({ account, chain: cfg.chain, to: cfg.tabline, data: snapshotData(r.planId) }));
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
                const settle = await wait(await walletClient.sendTransaction({ account, chain: cfg.chain, to: cfg.tabline, data: settleData(r) }));
                return settle.transactionHash;
            }
            catch (e) {
                throw new PartialChargeError(redeemTx, e.message.split("\n")[0]);
            }
        },
    };
}
