import { NextRequest, NextResponse } from "next/server";
import { sweep, type Candidate } from "@/lib/scan";
import { config } from "@/lib/config";
import { getKeypair, getConnection, getBalances, countNfts } from "@/lib/wallet";
import { executeBuy } from "@/lib/buy";
import { fetchHeldCardKeys } from "@/lib/owned";
import { cardKey, listingNameCore } from "@/lib/dedupe";
// NOTE: forwarding to the treasury is handled by a separate cron (/api/sweep)
// so a slow confirm+transfer can never eat into the buy path's 60s budget.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Best-effort guard against re-buying the same listing while it lingers in the
// ~60s-cached listing feed. Lives only as long as the warm serverless instance,
// which is fine: a duplicate attempt fails harmlessly on-chain (already sold),
// costing a sliver of gas, never a double USDC spend.
const recentlyAttempted = new Set<string>();

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

async function alert(text: string) {
  if (!config.alertWebhook) return;
  try {
    await fetch(config.alertWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, text }), // works for Discord & generic
    });
  } catch {
    /* alerting must never break the run */
  }
}

// Pokemon discount requirement, scaled by treasury inventory: normal picky floor
// when the treasury is healthy, ramping down to the aggressive floor as it
// approaches treasuryFloor — so we buy more readily to keep it topped up.
// treasuryCount == null (couldn't read) -> normal margin (still buys Pokemon).
function pokemonMargin(treasuryCount: number | null): number {
  const { treasuryTarget, treasuryFloor, pokemonMinMargin, pokemonMinMarginFloor } = config;
  if (treasuryCount == null || treasuryCount >= treasuryTarget) return pokemonMinMargin;
  if (treasuryCount <= treasuryFloor) return pokemonMinMarginFloor;
  const t = (treasuryCount - treasuryFloor) / (treasuryTarget - treasuryFloor);
  return pokemonMinMarginFloor + t * (pokemonMinMargin - pokemonMinMarginFloor);
}

// required discount (%) for a card, by category. Returns Infinity when the card
// is outside that category's price window, so it's always excluded.
//  - One Piece (supply build): any price up to onePieceMaxPriceUsd, flat floor.
//  - Pokemon (we hold plenty): only "expensive" cards (>= pokemonMinPriceUsd),
//    floor scaled by treasury inventory (pkMargin).
function requiredMarginPct(category: string | null, priceUsd: number, pkMargin: number): number {
  if (category === "One Piece") {
    return priceUsd <= config.onePieceMaxPriceUsd ? config.onePieceMinMargin * 100 : Infinity;
  }
  // Pokemon / default
  return priceUsd >= config.pokemonMinPriceUsd ? pkMargin * 100 : Infinity;
}

// Categories the dedupe applies to (falls back to forwarded categories).
const dedupeCats = (config.dedupeCategories.length ? config.dedupeCategories : config.forwardCategories);
// Grade-agnostic card identity for a listing: name(parsed from itemName)+year.
const candidateKey = (c: Candidate) => cardKey(listingNameCore(c.itemName), c.year);
// A candidate is a duplicate if it's in a deduped category AND we already hold
// that card. `held` null = dedupe unavailable this run → never treat as dup.
function isDuplicate(c: Candidate, held: Set<string> | null): boolean {
  if (held == null) return false;
  if (!dedupeCats.includes(c.category ?? "")) return false;
  return held.has(candidateKey(c));
}

// candidates that pass the BUYER's (stricter) gates, best discount first
function eligible(cands: Candidate[], pkMargin: number): Candidate[] {
  return cands
    .filter((c) => !config.blacklist.includes(c.nftAddress)) // bogus-insured / banned mints
    .filter((c) => c.currency && config.buyCurrencies.includes(c.currency))
    .filter((c) => c.type && config.buyTypes.includes(c.type)) // cards only, no sealed
    .filter((c) => c.spreadPct >= requiredMarginPct(c.category, c.priceUsd, pkMargin))
    .filter((c) => !recentlyAttempted.has(c.nftAddress))
    .sort((a, b) => b.spreadPct - a.spreadPct || b.spreadUsd - a.spreadUsd);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await sweep();

    // Read treasury inventory to scale the Pokemon discount (replenishment).
    // Best-effort: if we can't read it, fall back to the normal picky floor.
    let treasuryCount: number | null = null;
    if (config.destWallet) {
      try {
        treasuryCount = await countNfts(getConnection(), config.destWallet);
      } catch {
        /* keep null -> normal margin */
      }
    }
    const pkMargin = pokemonMargin(treasuryCount);

    // Dedupe: drop candidates for cards we already hold (treasury + burner).
    // `heldKeys` null = dedupe unavailable (disabled or DAS down) → buy as usual
    // rather than halt. Burner is included so a just-bought card (not yet
    // forwarded) blocks re-buying the same card on the next run.
    let heldKeys: Set<string> | null = null;
    if (config.skipDuplicates) {
      const owners: string[] = [];
      if (config.destWallet) owners.push(config.destWallet);
      try {
        owners.push(getKeypair().publicKey.toBase58());
      } catch {
        /* no burner secret (e.g. local dry-run) — dedupe vs treasury only */
      }
      if (owners.length) heldKeys = await fetchHeldCardKeys(owners, dedupeCats);
    }

    const eligibleAll = eligible(result.candidates, pkMargin);
    const picks = eligibleAll.filter((c) => !isDuplicate(c, heldKeys));
    const dedupedOut = eligibleAll.length - picks.length;
    const dedupeActive = config.skipDuplicates && heldKeys != null;

    // ---- DRY RUN: never spends. Shows exactly what it would buy. ----
    if (!config.botLive) {
      return NextResponse.json({
        ok: true,
        mode: "DRY_RUN",
        startedAt,
        scanned: result.scanned,
        treasuryCount,
        pokemonBuyingActive: Number.isFinite(pkMargin),
        pokemonMarginPct: Number.isFinite(pkMargin) ? Math.round(pkMargin * 1000) / 10 : null,
        belowInsured: result.candidates.length,
        dedupeActive,
        heldCards: heldKeys?.size ?? null,
        skippedDuplicates: dedupedOut,
        eligible: picks.length,
        wouldBuy: picks.slice(0, config.maxBuysPerRun).map((c) => ({
          item: c.itemName,
          priceUsd: c.priceUsd,
          insuredUsd: c.insuredUsd,
          discountPct: c.spreadPct,
          currency: c.currency,
          nftAddress: c.nftAddress,
          url: c.url,
        })),
      });
    }

    // ---- LIVE ----
    if (picks.length === 0) {
      return NextResponse.json({
        ok: true,
        mode: "LIVE",
        startedAt,
        eligible: 0,
        dedupeActive,
        skippedDuplicates: dedupedOut,
        bought: [],
      });
    }

    const kp = getKeypair();
    const conn = getConnection();
    const owner = kp.publicKey;
    const bought: unknown[] = [];

    // wallet balance is the hard cap. Read once per run; decrement optimistically
    // as we buy so a multi-buy run can't overspend.
    const bal = await getBalances(conn, owner);
    if (bal.sol <= config.minSolReserve) {
      await alert(`⛔ cc-sniper: SOL too low for gas (${bal.sol}). Skipping buys.`);
      return NextResponse.json({ ok: true, mode: "LIVE", startedAt, note: "SOL too low for gas", bought: [] });
    }
    let remainingUsdc = bal.usdc;
    // Keys bought THIS run — stops a multi-buy run from grabbing two listings of
    // the same card before either has landed in the held set.
    const boughtKeys = new Set<string>();

    for (const c of picks) {
      if (bought.length >= config.maxBuysPerRun) break;
      // skip picks we can't afford and fall through to the next-biggest discount,
      // rather than stalling on an unaffordable top pick
      if (remainingUsdc < c.priceUsd) continue;
      // skip a card we already bought earlier in this same run
      const key = candidateKey(c);
      if (config.skipDuplicates && dedupeCats.includes(c.category ?? "") && boughtKeys.has(key)) continue;

      recentlyAttempted.add(c.nftAddress);
      try {
        const res = await executeBuy(kp, c);
        remainingUsdc -= c.priceUsd;
        boughtKeys.add(key);
        const line = `✅ cc-sniper BOUGHT ${c.itemName} for $${c.priceUsd} (insured $${c.insuredUsd}, -${c.spreadPct}%) sig=${res.signature ?? "?"}`;
        await alert(line);
        // bought NFT lands in the burner; the /api/sweep cron forwards it to
        // the treasury on its own schedule.
        bought.push({ ...res, item: c.itemName, priceUsd: c.priceUsd, nftAddress: c.nftAddress });
      } catch (e: any) {
        const msg = `⚠️ cc-sniper buy FAILED for ${c.itemName} ($${c.priceUsd}): ${e?.message ?? e}`;
        await alert(msg);
        bought.push({ error: String(e?.message ?? e), item: c.itemName, nftAddress: c.nftAddress });
      }
    }

    return NextResponse.json({
      ok: true,
      mode: "LIVE",
      startedAt,
      finishedAt: new Date().toISOString(),
      treasuryCount,
      pokemonMarginPct: Math.round(pkMargin * 1000) / 10,
      dedupeActive,
      heldCards: heldKeys?.size ?? null,
      skippedDuplicates: dedupedOut,
      eligible: picks.length,
      bought,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, startedAt, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
