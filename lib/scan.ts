// Ported 1:1 from the Python dry-run scanner: paginate the public marketplace
// listing endpoint, find cards priced below their insured value (within budget
// and an optional margin), return candidates. NO signing/broadcasting here.

import { config } from "./config";

export interface Candidate {
  nftAddress: string;
  cardId: string | null;
  category: string | null;
  itemName: string;
  grade: string | null;
  gradingCompany: string | null;
  currency: string | null;
  price: number;
  priceUsd: number;
  insuredUsd: number;
  spreadUsd: number;
  spreadPct: number;
  listedAt: string | null;
  ownerWallet: string | null;
  url: string;
}

export interface SweepResult {
  scanned: number;
  candidates: Candidate[];
  solUsd: number;
  findTotal: number | null;
  totalPages: number | null;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": config.userAgent },
    // never serve us a stale cached body; we want the freshest listings
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function getSolUsd(): Promise<number> {
  try {
    const data = await getJson(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );
    const v = Number(data?.solana?.usd);
    return Number.isFinite(v) && v > 0 ? v : config.solUsdFallback;
  } catch {
    return config.solUsdFallback;
  }
}

function buildUrl(page: number): string {
  const params = new URLSearchParams({
    marketplaceStatus: "Buy now",
    marketplaceSource: "CC",
    listPriceMax: String(Math.trunc(config.maxSpendUsd)),
    orderBy: "listedDateDesc",
    page: String(page),
    step: String(config.pageStep),
  });
  for (const c of config.categories) params.append("categories", c);
  return `${config.apiBase}/marketplace?${params.toString()}`;
}

function toUsd(price: number, currency: string | null, solUsd: number): number | null {
  if (!Number.isFinite(price)) return null;
  if (currency === "USDC" || currency === "USD") return price;
  if (currency === "SOL") return price * solUsd;
  return null; // unknown currency — refuse to guess
}

function evaluate(card: any, solUsd: number): Candidate | null {
  const category = card?.category ?? null;
  if (config.categories.length && !config.categories.includes(category)) return null;

  const listing = card?.listing ?? {};
  const price = Number(listing?.price);
  const currency = listing?.currency ?? null;
  const priceUsd = toUsd(price, currency, solUsd);
  if (priceUsd == null || priceUsd <= 0) return null;

  const insured = Number(card?.insuredValue);
  if (!Number.isFinite(insured) || insured < config.minInsuredUsd) return null;

  if (priceUsd > config.maxSpendUsd) return null;
  // the core edge: priced below insured value, with optional margin
  if (priceUsd > insured * (1 - config.minMargin)) return null;

  const nft = card?.nftAddress;
  const spread = insured - priceUsd;
  return {
    nftAddress: nft,
    cardId: card?.id ?? null,
    category,
    itemName: String(card?.itemName ?? "").slice(0, 200),
    grade: card?.grade ?? null,
    gradingCompany: card?.gradingCompany ?? null,
    currency,
    price,
    priceUsd: round2(priceUsd),
    insuredUsd: round2(insured),
    spreadUsd: round2(spread),
    spreadPct: round1((100 * spread) / insured),
    listedAt: listing?.createdAt ?? null,
    ownerWallet: card?.owner?.wallet ?? null,
    url: `https://collectorcrypt.com/assets/solana/${nft}`,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

export async function sweep(): Promise<SweepResult> {
  const solUsd = await getSolUsd();
  let page = 1;
  let scanned = 0;
  let totalPages: number | null = null;
  let findTotal: number | null = null;
  const candidates: Candidate[] = [];

  while (page <= config.maxPages) {
    const data = await getJson(buildUrl(page));
    const cards: any[] = data?.filterNFtCard ?? [];
    if (totalPages == null) {
      totalPages = data?.totalPages ?? null;
      findTotal = data?.findTotal ?? null;
    }
    if (cards.length === 0) break;
    for (const c of cards) {
      scanned++;
      const cand = evaluate(c, solUsd);
      if (cand) candidates.push(cand);
    }
    if (totalPages != null && page >= totalPages) break;
    page++;
  }

  candidates.sort((a, b) => b.spreadPct - a.spreadPct);
  return { scanned, candidates, solUsd, findTotal, totalPages };
}
