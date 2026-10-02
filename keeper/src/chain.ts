import { encodeAbiParameters, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { tablineAbi } from "./abi";
import type { OnchainSubscription, Plan } from "./types";

/** Thin typed reader over the Tabline contract. */
export class Chain {
  constructor(
    readonly publicClient: PublicClient,
    readonly tabline: Address,
  ) {}

  async readPlan(planId: bigint): Promise<Plan> {
    const r = await this.publicClient.readContract({
      address: this.tabline,
      abi: tablineAbi,
      functionName: "plans",
      args: [planId],
    });
    const [merchant, keeper, payout, token, amount, period, kind, active] = r;
    if (merchant === "0x0000000000000000000000000000000000000000") throw new Error(`plan ${planId} does not exist`);
    return { merchant, keeper, payout, token, amount, period, kind: kind === 0 ? "fixed" : "metered", active };
  }

  async readSubscription(planId: bigint, subscriber: Address): Promise<OnchainSubscription> {
    const [startedAt, nextDueAt, cancelled, totalPaid] = await this.publicClient.readContract({
      address: this.tabline,
      abi: tablineAbi,
      functionName: "subscriptions",
      args: [planId, subscriber],
    });
    return { startedAt: Number(startedAt), nextDueAt: Number(nextDueAt), cancelled, totalPaid };
  }

  async isDue(planId: bigint, subscriber: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.tabline,
      abi: tablineAbi,
      functionName: "isDue",
      args: [planId, subscriber],
    });
  }

  async isSettled(planId: bigint, subscriber: Address, chargeKey: Hex): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.tabline,
      abi: tablineAbi,
      functionName: "settled",
      args: [settlementId(planId, subscriber, chargeKey)],
    });
  }
}

/** Mirrors Tabline.settle: keccak256(abi.encode(planId, subscriber, chargeKey)). */
export function settlementId(planId: bigint, subscriber: Address, chargeKey: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "bytes32" }],
      [planId, subscriber, chargeKey],
    ),
  );
}

/** Deterministic charge key for a fixed-plan period, derived from the on-chain due date. */
export function fixedChargeKey(dueAt: number): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "uint48" }], ["fixed", dueAt]));
}

/** Deterministic charge key for a metered settlement, derived from the usage ids it covers. */
export function meteredChargeKey(usageIds: string[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "string" }], ["metered", usageIds.join(",")]));
}
