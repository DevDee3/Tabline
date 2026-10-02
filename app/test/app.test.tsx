import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { Shop } from "../src/views/Shop";
import { Tabs } from "../src/views/Tabs";
import { Merchant } from "../src/views/Merchant";
import { Agent } from "../src/views/Agent";
import { backend } from "../src/lib/env";

// These exercise the real component tree end to end against DemoBackend (see src/lib/demo.ts) -- no wallet,
// no keeper, no network. They aren't the wallet/on-chain flow itself (that's the Sep-22 spike's job) but they
// do prove the pages actually render, wire up to the Backend interface correctly, and respond to interaction.

describe("Shop (checkout)", () => {
  it("renders both plans and opens a tab", async () => {
    const user = userEvent.setup();
    render(<Shop />);

    expect(await screen.findByText(/Inkwell checks your writing/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/USDC every month, unlimited checks/i)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /open a tab/i }));

    expect(await screen.findByText(/your tab is open/i)).toBeInTheDocument();
    expect(screen.getByText(/total paid/i)).toBeInTheDocument();
  });

  it("switches to the metered plan and shows a budget selector", async () => {
    const user = userEvent.setup();
    render(<Shop />);
    await screen.findByText(/Inkwell checks your writing/i);

    await user.click(screen.getByRole("radio", { name: /pay as you go/i }));
    expect(screen.getByLabelText(/monthly spending limit/i)).toBeInTheDocument();
  });
});

describe("Tabs (subscriber view)", () => {
  beforeAll(async () => {
    // Independent of whether the Shop tests ran first: make sure the connected demo account (ME) has at
    // least one open tab, ignoring "already subscribed" if a prior test already opened one.
    await backend.subscribe("1").catch(() => {});
  });

  it("gates behind connect, then lists tabs with a cancel control", async () => {
    const user = userEvent.setup();
    render(<Tabs />);

    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /connect wallet/i }));

    // The connected demo account (ME) gets its own tab the moment one is opened via Shop/backend.subscribe;
    // the seeded past_due/active history in DemoBackend belongs to other demo addresses, not the connected one.
    expect(await screen.findByText(/showing tabs for/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^Open$/)).toBeInTheDocument());
    expect(screen.getAllByText(/cancel this tab/i).length).toBeGreaterThan(0);
  });

  it("cancel requires an explicit confirm step", async () => {
    const user = userEvent.setup();
    render(<Tabs />);
    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    await waitFor(() => expect(screen.getAllByText(/cancel this tab/i).length).toBeGreaterThan(0));

    await user.click(screen.getAllByText(/cancel this tab/i)[0]);
    expect(screen.getByText(/also record the cancel on arbitrum/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep it open/i })).toBeInTheDocument();
  });
});

describe("Merchant dashboard", () => {
  it("shows figures and the subscriber table in demo mode (no key gate)", async () => {
    render(<Merchant />);
    expect(await screen.findByText(/monthly recurring/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/subscribers/i)).toBeInTheDocument());
    expect(screen.getAllByText(/payment failing/i).length).toBeGreaterThan(0);
  });

  it("creates a new plan through the form", async () => {
    const user = userEvent.setup();
    render(<Merchant />);
    await screen.findByText(/create a plan/i);

    await user.type(screen.getByLabelText(/payout address/i), "0x1111111111111111111111111111111111111e");
    await user.click(screen.getByRole("button", { name: /create plan/i }));

    expect(await screen.findByText(/created\./i)).toBeInTheDocument();
  });
});

describe("Agent (metered pay-per-call demo)", () => {
  it("requires connecting first, then an existing pay-as-you-go tab", async () => {
    const user = userEvent.setup();
    render(<Agent />);
    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    // The demo account has no plan-2 (metered) subscription until one is opened from the shop.
    expect(await screen.findByText(/no pay-as-you-go tab yet/i)).toBeInTheDocument();
  });
});
