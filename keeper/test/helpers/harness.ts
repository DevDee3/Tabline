import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { createPublicClient, createTestClient, createWalletClient, http, parseUnits, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { tablineAbi } from "../../src/abi";
import { Chain } from "../../src/chain";
import type { ChargeRequest, Redeemer } from "../../src/redeemers";
import type { StoredGrant } from "../../src/types";
import { mockUsdcAbi, mockUsdcBytecode, tablineBytecode } from "./bytecode";

// Anvil's well-known dev mnemonic. Test-only, worthless. Indexes: 0 merchant, 1 keeper, 2 alice, 3 bob.
const MNEMONIC = "test test test test test test test test test test test junk";
const INDEX = { merchant: 0, keeper: 1, alice: 2, bob: 3 } as const;
export const KEYS = INDEX;

export const acct = (k: keyof typeof KEYS) => mnemonicToAccount(MNEMONIC, { addressIndex: INDEX[k] });
export const USDC = (n: string) => parseUnits(n, 6);

export async function startAnvil(port: number): Promise<{ url: string; stop: () => void }> {
  const bin = process.env.ANVIL_BIN ?? `${homedir()}/.foundry/bin/anvil`;
  const proc: ChildProcess = spawn(bin, ["--port", String(port), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return { url, stop: () => proc.kill() };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error("anvil did not start");
}

export interface World {
  url: string;
  tabline: Address;
  usdc: Address;
  chain: Chain;
  publicClient: ReturnType<typeof createPublicClient>;
  wallet: (k: keyof typeof KEYS) => ReturnType<typeof createWalletClient>;
  testClient: ReturnType<typeof createTestClient>;
  warp: (seconds: number) => Promise<void>;
  clock: () => number;
  balance: (who: Address) => Promise<bigint>;
  createPlan: (a: { amount: bigint; period: number; kind: 0 | 1 }) => Promise<bigint>;
  grantFor: (subscriber: Address, o?: Partial<StoredGrant>) => StoredGrant;
}

let clockOffset = 0;

export async function deployWorld(url: string): Promise<World> {
  const transport = http(url);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const testClient = createTestClient({ chain: foundry, mode: "anvil", transport });
  const wallet = (k: keyof typeof KEYS) => createWalletClient({ account: acct(k), chain: foundry, transport });

  const deploy = async (abi: readonly unknown[], bytecode: Hex) => {
    const hash = await wallet("merchant").deployContract({ abi: abi as never, bytecode, account: acct("merchant"), chain: foundry } as never);
    const r = await publicClient.waitForTransactionReceipt({ hash });
    return r.contractAddress as Address;
  };
  const tabline = await deploy(tablineAbi, tablineBytecode as Hex);
  const usdc = await deploy(mockUsdcAbi, mockUsdcBytecode as Hex);

  for (const who of ["alice", "bob"] as const) {
    const h = await wallet("merchant").writeContract({ address: usdc, abi: mockUsdcAbi, functionName: "mint", args: [acct(who).address, USDC("1000")], account: acct("merchant"), chain: foundry });
    await publicClient.waitForTransactionReceipt({ hash: h });
  }

  const world: World = {
    url,
    tabline,
    usdc,
    chain: new Chain(publicClient as never, tabline),
    publicClient,
    wallet,
    testClient,
    clock: () => Math.floor(Date.now() / 1000) + clockOffset,
    async warp(seconds) {
      clockOffset += seconds;
      await testClient.increaseTime({ seconds });
      await testClient.mine({ blocks: 1 });
    },
    balance: (who) => publicClient.readContract({ address: usdc, abi: mockUsdcAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>,
    async createPlan({ amount, period, kind }) {
      const h = await wallet("merchant").writeContract({
        address: tabline, abi: tablineAbi, functionName: "createPlan",
        args: [usdc, acct("merchant").address, acct("keeper").address, amount, period, kind],
        account: acct("merchant"), chain: foundry,
      });
      await publicClient.waitForTransactionReceipt({ hash: h });
      return (await publicClient.readContract({ address: tabline, abi: tablineAbi, functionName: "planCount" })) as bigint;
    },
    grantFor(subscriber, o = {}) {
      return {
        context: "0x1234", delegationManager: "0x0000000000000000000000000000000000000dad", chainId: foundry.id,
        from: subscriber, to: acct("keeper").address, tokenAddress: usdc,
        periodAmount: USDC("100").toString(), periodDuration: 30 * 24 * 3600,
        expiry: world.clock() + 365 * 24 * 3600, ...o,
      };
    },
  };
  return world;
}

/**
 * TEST-ONLY redeemer. It runs the real Tabline snapshot/settle calls on a local chain, but stands in for the
 * MetaMask delegation with a direct transfer from the subscriber's key plus an EMULATED period cap. It exercises
 * the engine and the contract together; it does NOT prove anything about MetaMask's own enforcement.
 */
export class DirectPayerRedeemer implements Redeemer {
  readonly mode = "test-direct-payer";
  readonly keeperAddress = acct("keeper").address;
  failWith?: string;
  private spent: { at: number; amount: bigint }[] = [];
  calls = 0;

  constructor(private readonly w: World, private readonly payers: Record<string, keyof typeof KEYS>) {}

  async charge(r: ChargeRequest): Promise<Hex> {
    this.calls++;
    if (this.failWith) throw new Error(this.failWith);
    const keeper = this.w.wallet("keeper");
    const wait = (hash: Hex) => this.w.publicClient.waitForTransactionReceipt({ hash });

    await wait(await keeper.writeContract({ address: this.w.tabline, abi: tablineAbi, functionName: "snapshot", args: [r.planId], account: acct("keeper"), chain: foundry }));

    const now = this.w.clock();
    const window = r.grant.periodDuration;
    const used = this.spent.filter((s) => s.at > now - window).reduce((a, s) => a + s.amount, 0n);
    if (used + r.amount > BigInt(r.grant.periodAmount)) throw new Error("emulated wallet: amount exceeds period allowance");

    const payerKey = this.payers[r.subscriber.toLowerCase()];
    await wait(await this.w.wallet(payerKey).writeContract({ address: this.w.usdc, abi: mockUsdcAbi, functionName: "transfer", args: [r.plan.payout, r.amount], account: acct(payerKey), chain: foundry }));
    this.spent.push({ at: now, amount: r.amount });

    const settleHash = await keeper.writeContract({ address: this.w.tabline, abi: tablineAbi, functionName: "settle", args: [r.planId, r.subscriber, r.chargeKey, r.amount], account: acct("keeper"), chain: foundry });
    const receipt = await wait(settleHash);
    if (receipt.status !== "success") throw new Error(`settle ${settleHash} reverted`);
    return settleHash;
  }
}
