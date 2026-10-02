"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Chain = void 0;
exports.settlementId = settlementId;
exports.fixedChargeKey = fixedChargeKey;
exports.meteredChargeKey = meteredChargeKey;
const viem_1 = require("viem");
const abi_1 = require("./abi");
/** Thin typed reader over the Tabline contract. */
class Chain {
    publicClient;
    tabline;
    constructor(publicClient, tabline) {
        this.publicClient = publicClient;
        this.tabline = tabline;
    }
    async readPlan(planId) {
        const r = await this.publicClient.readContract({
            address: this.tabline,
            abi: abi_1.tablineAbi,
            functionName: "plans",
            args: [planId],
        });
        const [merchant, keeper, payout, token, amount, period, kind, active] = r;
        if (merchant === "0x0000000000000000000000000000000000000000")
            throw new Error(`plan ${planId} does not exist`);
        return { merchant, keeper, payout, token, amount, period, kind: kind === 0 ? "fixed" : "metered", active };
    }
    async readSubscription(planId, subscriber) {
        const [startedAt, nextDueAt, cancelled, totalPaid] = await this.publicClient.readContract({
            address: this.tabline,
            abi: abi_1.tablineAbi,
            functionName: "subscriptions",
            args: [planId, subscriber],
        });
        return { startedAt: Number(startedAt), nextDueAt: Number(nextDueAt), cancelled, totalPaid };
    }
    async isDue(planId, subscriber) {
        return this.publicClient.readContract({
            address: this.tabline,
            abi: abi_1.tablineAbi,
            functionName: "isDue",
            args: [planId, subscriber],
        });
    }
    async isSettled(planId, subscriber, chargeKey) {
        return this.publicClient.readContract({
            address: this.tabline,
            abi: abi_1.tablineAbi,
            functionName: "settled",
            args: [settlementId(planId, subscriber, chargeKey)],
        });
    }
}
exports.Chain = Chain;
/** Mirrors Tabline.settle: keccak256(abi.encode(planId, subscriber, chargeKey)). */
function settlementId(planId, subscriber, chargeKey) {
    return (0, viem_1.keccak256)((0, viem_1.encodeAbiParameters)([{ type: "uint256" }, { type: "address" }, { type: "bytes32" }], [planId, subscriber, chargeKey]));
}
/** Deterministic charge key for a fixed-plan period, derived from the on-chain due date. */
function fixedChargeKey(dueAt) {
    return (0, viem_1.keccak256)((0, viem_1.encodeAbiParameters)([{ type: "string" }, { type: "uint48" }], ["fixed", dueAt]));
}
/** Deterministic charge key for a metered settlement, derived from the usage ids it covers. */
function meteredChargeKey(usageIds) {
    return (0, viem_1.keccak256)((0, viem_1.encodeAbiParameters)([{ type: "string" }, { type: "string" }], ["metered", usageIds.join(",")]));
}
