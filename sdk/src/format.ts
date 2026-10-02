/** USDC-style 6-decimal token amounts <-> human strings. */
export const TOKEN_DECIMALS = 6;

export function formatUsdc(amount: string | bigint, opts: { minFraction?: number } = {}): string {
  const v = typeof amount === "bigint" ? amount : BigInt(amount);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  const min = opts.minFraction ?? 2;
  if (frac.length < min) frac = frac.padEnd(min, "0");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export function parseUsdc(input: string): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d{0,6})?$/.test(s)) throw new Error(`"${input}" is not a valid amount (up to 6 decimals)`);
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(f.padEnd(TOKEN_DECIMALS, "0"));
}

export function formatDuration(seconds: number): string {
  const d = seconds / 86400;
  if (seconds % (30 * 86400) === 0 && d >= 30) return seconds === 30 * 86400 ? "month" : `${d / 30} months`;
  if (seconds % (7 * 86400) === 0 && d >= 7) return seconds === 7 * 86400 ? "week" : `${d / 7} weeks`;
  if (seconds % 86400 === 0) return seconds === 86400 ? "day" : `${d} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  return `${seconds} seconds`;
}
