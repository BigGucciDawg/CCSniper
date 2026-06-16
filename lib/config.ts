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

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null) return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export interface MarginBand {
  maxPriceUsd: number; // applies to cards priced at or below this
  minMargin: number; // required discount to insured value (0.05 = 5%)
}

// Parse "75:0.05,200:0.10,350:0.15" -> sorted bands. Each pair is price:margin.
function bands(name: string, fallback: MarginBand[]): MarginBand[] {
  const v = process.env[name];
  if (!v) return fallback;
  const parsed: MarginBand[] = [];
  for (const pair of v.split(",")) {
    const [p, m] = pair.split(":").map((s) => Number(s.trim()));
    if (Number.isFinite(p) && Number.isFinite(m)) parsed.push({ maxPriceUsd: p, minMargin: m });
  }
  parsed.sort((a, b) => a.maxPriceUsd - b.maxPriceUsd);
  return parsed.length ? parsed : fallback;
}

export const config = {
  apiBase: process.env.CC_API_BASE || "https://api.collectorcrypt.com",

  // never consider a card priced above this (USD) — also caps the listing query.
  // keep >= the largest margin band's maxPriceUsd.
  maxSpendUsd: num("CC_MAX_SPEND_USD", 350),
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

  // ---- buyer (phase 2) ----
  // MASTER SWITCH: nothing is ever bought unless this is explicitly true.
  // Default false => dry-run (logs what it WOULD buy, spends nothing).
  botLive: bool("CC_BOT_LIVE", false),
  // Required discount by price band: the first band whose maxPriceUsd >= the
  // card's price applies. Cards priced above the largest band are never bought,
  // so the top band's maxPriceUsd is the effective hard spend ceiling.
  //   <= $75 -> 5% off, <= $200 -> 10% off, <= $350 -> 15% off, else skip.
  // Override via env: CC_MARGIN_BANDS="75:0.05,200:0.10,350:0.15"
  marginBands: bands("CC_MARGIN_BANDS", [
    { maxPriceUsd: 75, minMargin: 0.05 },
    { maxPriceUsd: 200, minMargin: 0.1 },
    { maxPriceUsd: 350, minMargin: 0.15 },
  ]),
  // only buy listings in these currencies (we hold/pay these). USDC only for v1.
  buyCurrencies: list("CC_BUY_CURRENCIES", ["USDC"]),
  // only buy these item types. "Card" = graded singles; excludes "Sealed"
  // (booster bundles/boxes/packs).
  buyTypes: list("CC_BUY_TYPES", ["Card"]),
  // where bought NFTs are forwarded after purchase. Empty = keep in burner.
  destWallet: process.env.CC_DEST_WALLET || "",
  // never make more than this many purchases per cron run (throttle).
  maxBuysPerRun: num("CC_MAX_BUYS_PER_RUN", 1),
  // keep this much SOL in reserve for gas (don't drain it).
  minSolReserve: num("CC_MIN_SOL_RESERVE", 0.01),
  // optional Discord/Telegram-style webhook to alert + audit each buy attempt.
  alertWebhook: process.env.CC_ALERT_WEBHOOK || "",
};
