import { describe, expect, it, vi } from "vitest";
import { TablineClient } from "../src/client";
import { TablineError } from "../src/types";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("TablineClient", () => {
  it("GETs plans without auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: "1", kind: "fixed" }));
    const client = new TablineClient({ baseUrl: "https://api.test", fetchImpl });
    const plan = await client.getPlan("1");
    expect(plan).toMatchObject({ id: "1", kind: "fixed" });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.test/v1/plans/1", expect.objectContaining({ method: "GET" }));
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    const client = new TablineClient({ baseUrl: "https://api.test/", fetchImpl });
    await client.getConfig();
    expect(fetchImpl).toHaveBeenCalledWith("https://api.test/v1/config", expect.anything());
  });

  it("throws TablineError with the API's code and message on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { error: { code: "unknown_plan", message: "plan 99 does not exist" } }));
    const client = new TablineClient({ baseUrl: "https://api.test", fetchImpl });
    await expect(client.getPlan("99")).rejects.toMatchObject({ code: "unknown_plan", message: "plan 99 does not exist" });
  });

  it("loads merchant data without an API key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { activeSubscriptions: 3 }));
    const client = new TablineClient({ baseUrl: "https://api.test", fetchImpl });
    await client.getOverview();
    const [, init] = fetchImpl.mock.calls[0];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("POSTs a subscribe request with the planId, subscriber, and raw grant", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "sub_1", status: "active" }));
    const client = new TablineClient({ baseUrl: "https://api.test", fetchImpl });
    await client.subscribe("1", "0xabc0000000000000000000000000000000000a", [{ chainId: 1 }]);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ planId: "1", subscriber: "0xabc0000000000000000000000000000000000a", grant: [{ chainId: 1 }] });
  });

  it("serializes bigint values in wallet grants", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: "sub_1", status: "active" }));
    const client = new TablineClient({ baseUrl: "https://api.test", fetchImpl });
    await client.subscribe("1", "0xabc0000000000000000000000000000000000a", [{ chainId: 421614n, permission: { data: { periodAmount: 9000000n } } }]);
    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body as string).grant[0]).toEqual({ chainId: "421614", permission: { data: { periodAmount: "9000000" } } });
  });

  it("builds query strings for filtered list calls without requiring auth", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));
    const client = new TablineClient({ baseUrl: "https://api.test", fetchImpl });
    await client.listSubscriptions({ subscriber: "0xabc0000000000000000000000000000000000a" });
    expect(fetchImpl.mock.calls[0][0]).toContain("subscriber=0xabc0000000000000000000000000000000000a");
  });
});
