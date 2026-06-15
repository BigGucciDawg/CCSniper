// Strategy + run knobs. Env vars override the defaults so you can tune in the
// Vercel dashboard without a redeploy.

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export const config = {
  apiBase: process.env.CC_API_BASE || "https://api.collectorcrypt.com",

  // never consider a card priced above this (USD)
  maxSpendUsd: num("CC_MAX_SPEND_USD", 100),
  // require price <= insured * (1 - minMargin). 0 = any discount below insured.
  // raise to ~0.12-0.15 before going live so 2% fee + gas don't eat the edge.
  minMargin: num("CC_MIN_MARGIN", 0),
  // ignore dust / placeholder insured values
  minInsuredUsd: num("CC_MIN_INSURED_USD", 1),
  // only these categories are scanned (server-side filter + client guard)
  categories: list("CC_CATEGORIES", ["Pokemon"]),

  // pagination
  pageStep: num("CC_PAGE_STEP", 100),
  maxPages: num("CC_MAX_PAGES", 200),

  // SOL/USD fallback if the live price fetch fails (SOL-denominated listings)
  solUsdFallback: num("CC_SOL_USD_FALLBACK", 150),

  userAgent: "cc-sniper/1.0 (+vercel-cron)",
};
