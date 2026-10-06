import { DemoBackend } from "./demo";
import { HttpBackend, type Backend } from "./backend";

// Next.js only inlines env vars prefixed NEXT_PUBLIC_ into client bundles (the old Vite build used VITE_*).
const KEEPER_URL = process.env.NEXT_PUBLIC_KEEPER_URL;
const APP_KEEPER_URL = KEEPER_URL ? "/api/keeper" : undefined;

// `?demo` in the URL forces demo mode even if a keeper URL is configured. Guarded for SSR, where `window` isn't
// available -- the server-rendered pass always treats this as unset, which only matters if someone deep-links
// `?demo` while NEXT_PUBLIC_KEEPER_URL is also set; the common case (no keeper configured) is unaffected either way.
const hasDemoParam = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");

export const IS_DEMO = hasDemoParam || !KEEPER_URL;
export const PLAN_FIXED = process.env.NEXT_PUBLIC_PLAN_FIXED ?? (IS_DEMO ? "1" : "");
export const PLAN_METERED = process.env.NEXT_PUBLIC_PLAN_METERED ?? (IS_DEMO ? "2" : "");
/** Optional token configured for the currently selected chain. Never default this to a mainnet address. */
export const TOKEN_ADDRESS = process.env.NEXT_PUBLIC_TOKEN_ADDRESS?.trim() ?? "";
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? "";
/** For display / building the checkout widget's api-url attribute. */
export const KEEPER_API_URL = APP_KEEPER_URL ?? "http://localhost:8787";

export const backend: Backend = IS_DEMO ? new DemoBackend() : new HttpBackend(APP_KEEPER_URL as string);
