import { beforeEach, describe, expect, it, vi } from "vitest";

// Tabline.subscribe() orchestrates TablineClient + wallet.ts. wallet.ts's own wire-protocol correctness is covered
// by the Sep-22 spike (real MetaMask, typechecked against the live SDK); this test is a unit test of the
// orchestration around it: budget defaulting, wallet-missing handling, and error wrapping.
vi.mock("../src/wallet", () => ({
  requestTab: vi.fn(),
  walletSupportsTabline: vi.fn().mockResolvedValue(true),
}));

import { Tabline } from "../src/client";
import { TablineError } from "../src/types";
import { requestTab, walletSupportsTabline } from "../src/wallet";

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ALICE = "0xabc0000000000000000000000000000000000a";

function fakeProvider(accounts: string[] = [ALICE]): any {
  return { request: vi.fn().mockResolvedValue(accounts) };
}

describe("Tabline.subscribe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws no_wallet when no provider is available", async () => {
    const t = new Tabline({ apiUrl: "https://api.test", provider: undefined });
    await expect(t.subscribe({ planId: "1" })).rejects.toMatchObject({ code: "no_wallet" });
  });

  it("defaults the requested budget to the plan's price and registers the subscription", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { chainId: 421614, keeperAddress: "0xkeeper", tabline: "0xtab" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "1", token: "0xusdc", amount: "10000000", period: 2592000, kind: "fixed", active: true }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "sub_1", status: "active", planId: "1" }));

    (requestTab as ReturnType<typeof vi.fn>).mockResolvedValue([{ chainId: 421614, context: "0x1" }]);

    const provider = fakeProvider();
    const t = new Tabline({ apiUrl: "https://api.test", provider, fetchImpl });
    const sub = await t.subscribe({ planId: "1" });

    expect(sub).toMatchObject({ id: "sub_1", status: "active" });
    expect(requestTab).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: "0xusdc", periodAmount: 10_000_000n, periodDurationSeconds: 2_592_000 }));
    const subscribeCall = fetchImpl.mock.calls[2];
    expect(JSON.parse(subscribeCall[1].body)).toMatchObject({ planId: "1", subscriber: ALICE });
  });

  it("honors an explicit budget instead of the plan price", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { chainId: 421614, keeperAddress: "0xkeeper", tabline: "0xtab" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "2", token: "0xusdc", amount: "5000000", period: 0, kind: "metered", active: true }))
      .mockResolvedValueOnce(jsonResponse(201, { id: "sub_2", status: "active" }));
    (requestTab as ReturnType<typeof vi.fn>).mockResolvedValue([{}]);

    const t = new Tabline({ apiUrl: "https://api.test", provider: fakeProvider(), fetchImpl });
    await t.subscribe({ planId: "2", budget: 20_000_000n });

    expect(requestTab).toHaveBeenCalledWith(expect.objectContaining({ periodAmount: 20_000_000n, periodDurationSeconds: 30 * 24 * 3600 }));
  });

  it("wraps a rejected wallet request as permission_denied", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { chainId: 421614, keeperAddress: "0xkeeper" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "1", token: "0xusdc", amount: "1", period: 100, kind: "fixed", active: true }));
    (requestTab as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("User rejected the request"));

    const t = new Tabline({ apiUrl: "https://api.test", provider: fakeProvider(), fetchImpl });
    await expect(t.subscribe({ planId: "1" })).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("surfaces permission_unsupported when the wallet lacks the permission type on this chain", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { id: "1", token: "0xusdc", amount: "1", period: 100, kind: "fixed", active: true }))
      .mockResolvedValueOnce(jsonResponse(200, { chainId: 1, keeperAddress: "0xkeeper" }));
    (walletSupportsTabline as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const t = new Tabline({ apiUrl: "https://api.test", provider: fakeProvider(), fetchImpl });
    const err = await t.subscribe({ planId: "1" }).catch((e) => e);
    expect(err).toBeInstanceOf(TablineError);
    expect(err).toMatchObject({ code: "permission_unsupported" });
  });
});
