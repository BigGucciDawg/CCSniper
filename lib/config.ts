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

export const config = {
  apiBase: process.env.CC_API_BASE || "https://api.collectorcrypt.com",

  // never consider a card priced above this (USD) — also caps the listing query.
  // this is the effective Pokemon upper price bound (One Piece has its own cap).
  maxSpendUsd: num("CC_MAX_SPEND_USD", 350),
  // require price <= insured * (1 - minMargin). 0 = any discount below insured.
  // raise to ~0.12-0.15 before going live so 2% fee + gas don't eat the edge.
  minMargin: num("CC_MIN_MARGIN", 0),
  // ignore dust / placeholder insured values
  minInsuredUsd: num("CC_MIN_INSURED_USD", 1),
  // only these categories are scanned/bought (server-side filter + client guard).
  // One Piece paused for now (focus on Pokemon); held One Piece stay in burner.
  // Re-add "One Piece" here (or via CC_CATEGORIES) to resume building that supply.
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
  // Pokemon: focus on low-value cards — only buy those with INSURED value below
  // pokemonMaxInsuredUsd, and only when there's an actual discount (price strictly
  // below insured). pokemonMinMargin is an optional extra discount floor;
  // default 0 means "any discount" (just has to be below insured value).
  pokemonMaxInsuredUsd: num("CC_POKEMON_MAX_INSURED_USD", 100),
  pokemonMinMargin: num("CC_POKEMON_MIN_MARGIN", 0),
  // never buy these mints (e.g. bogus insured value). CC_BLACKLIST appends more.
  blacklist: [
    "ghSZnm9k1VQtw9JCdwnYH5My587ePsPextg6JfZ7zKf", // Squirtle CGC 10 - fake $866 insured
    ...list("CC_BLACKLIST", []),
  ],
  // One Piece is bought to build supply for the new game mode: flat min discount,
  // its own price ceiling, and (see forwardCategories) kept in the burner.
  onePieceMinMargin: num("CC_ONEPIECE_MIN_MARGIN", 0.075),
  onePieceMaxPriceUsd: num("CC_ONEPIECE_MAX_PRICE_USD", 200),
  // categories whose cards are forwarded to destWallet after purchase. Anything
  // not listed here is KEPT in the burner (e.g. One Piece supply).
  forwardCategories: list("CC_FORWARD_CATEGORIES", ["Pokemon"]),
  // Don't buy a card we already hold (treasury + burner). Judged by card
  // identity (name+year), grade-agnostic — one copy of a card is enough.
  skipDuplicates: bool("CC_SKIP_DUPLICATES", true),
  // categories the dedupe applies to. Defaults to the forwarded (treasury game
  // inventory) categories; categories accumulated as SUPPLY (One Piece) are
  // intentionally NOT deduped, so we keep buying their copies. Falls back to
  // forwardCategories when the env is unset.
  dedupeCategories: list("CC_DEDUPE_CATEGORIES", ["Pokemon"]),
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
