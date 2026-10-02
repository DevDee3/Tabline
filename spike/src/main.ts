import { createWalletClient, custom, isAddress, parseUnits, type Address, type EIP1193Provider } from "viem";
import { erc7715ProviderActions } from "@metamask/smart-accounts-kit/actions";
import { NETWORKS, PERMISSION_TYPE, safeStringify, type NetworkKey } from "./config";

/**
 * SPIKE (Sep 22 gate). Answers, with real wallet responses, the questions I could not verify from docs:
 *   1. Does MetaMask report `erc20-token-periodic` as supported on the Arbitrum chain we pick?
 *   2. Does the permission grant work, and what do `context` / `delegationManager` look like?
 * The granted permission is exported as grant.json for keeper/redeem-eoa.ts.
 */

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (msg: string) => {
  const el = $("log");
  el.textContent += `${msg}\n`;
  el.scrollTop = el.scrollHeight;
};

let grantJson = "";

function walletClient() {
  if (!window.ethereum) throw new Error("No injected wallet found. Install MetaMask v13.23.0 or later.");
  return createWalletClient({ transport: custom(window.ethereum) }).extend(erc7715ProviderActions());
}

function selectedNetwork() {
  const key = $<HTMLSelectElement>("network").value as NetworkKey;
  return { key, ...NETWORKS[key] };
}

$("btn-supported").addEventListener("click", async () => {
  try {
    const { chain } = selectedNetwork();
    const supported = await walletClient().getSupportedExecutionPermissions();
    log("getSupportedExecutionPermissions():");
    log(safeStringify(supported));

    const entry = (supported as Record<string, { chainIds: (string | number)[] } | undefined>)[PERMISSION_TYPE];
    const hex = `0x${chain.id.toString(16)}`;
    const ok = entry?.chainIds.some((c) => String(c).toLowerCase() === hex || Number(c) === chain.id);
    log(
      ok
        ? `PASS: ${PERMISSION_TYPE} is supported on ${chain.name} (${chain.id}).`
        : `FAIL: ${PERMISSION_TYPE} NOT listed for ${chain.name} (${chain.id}). Fallback: Arbitrum Sepolia or raw delegations.`,
    );
  } catch (e) {
    log(`ERROR: ${(e as Error).message}`);
  }
});

$("btn-grant").addEventListener("click", async () => {
  try {
    const { chain, usdc } = selectedNetwork();
    const to = $<HTMLInputElement>("session").value.trim();
    if (!isAddress(to)) throw new Error("Enter the keeper (session account) address first.");

    const periodAmount = parseUnits($<HTMLInputElement>("amount").value || "1", 6);
    const periodDuration = Number($<HTMLInputElement>("period").value || "86400");
    const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

    const granted = await walletClient().requestExecutionPermissions([
      {
        chainId: chain.id,
        expiry,
        to: to as Address,
        permission: {
          type: PERMISSION_TYPE,
          data: {
            tokenAddress: usdc,
            periodAmount,
            periodDuration,
            justification: "Tabline spike: recurring USDC charge test",
          },
          isAdjustmentAllowed: true,
        },
      },
    ]);

    log("requestExecutionPermissions() granted:");
    grantJson = safeStringify(granted);
    log(grantJson);
    ($("btn-download") as HTMLButtonElement).disabled = false;
  } catch (e) {
    log(`ERROR: ${(e as Error).message}`);
  }
});

$("btn-download").addEventListener("click", () => {
  const blob = new Blob([grantJson], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "grant.json";
  a.click();
});
