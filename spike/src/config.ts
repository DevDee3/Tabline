import { arbitrum, arbitrumSepolia } from "viem/chains";
import type { Address } from "viem";

/**
 * Chains the spike can target. USDC addresses are Circle's native USDC deployments as I know them:
 * VERIFY both against https://developers.circle.com/stablecoins/usdc-contract-addresses before sending real funds.
 */
export const NETWORKS = {
  arbitrumSepolia: {
    chain: arbitrumSepolia,
    usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" as Address,
    label: "Arbitrum Sepolia (testnet)",
  },
  arbitrum: {
    chain: arbitrum,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address,
    label: "Arbitrum One (mainnet, real funds)",
  },
} as const;

export type NetworkKey = keyof typeof NETWORKS;

/** The permission type Tabline is built on. */
export const PERMISSION_TYPE = "erc20-token-periodic" as const;

/** JSON.stringify that survives bigint values in permission responses. */
export function safeStringify(value: unknown, space = 2): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), space);
}
