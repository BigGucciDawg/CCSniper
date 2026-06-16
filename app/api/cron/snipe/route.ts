import { NextRequest, NextResponse } from "next/server";
import { sweep, type Candidate } from "@/lib/scan";
import { config } from "@/lib/config";
import { getKeypair, getConnection, getBalances } from "@/lib/wallet";
import { executeBuy } from "@/lib/buy";
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

// required discount (%) for a card, by category. One Piece uses a flat floor
// (supply-building); other categories use the price-band schedule. Returns
// Infinity for prices above the top band so they're always excluded.
function requiredMarginPct(category: string | null, priceUsd: number): number {
  if (category === "One Piece") return config.onePieceMinMargin * 100;
  for (const b of config.marginBands) {
    if (priceUsd <= b.maxPriceUsd) return b.minMargin * 100;
  }
  return Infinity;
}

// candidates that pass the BUYER's (stricter) gates, best discount first
function eligible(cands: Candidate[]): Candidate[] {
  return cands
    .filter((c) => c.currency && config.buyCurrencies.includes(c.currency))
    .filter((c) => c.type && config.buyTypes.includes(c.type)) // cards only, no sealed
    .filter((c) => c.spreadPct >= requiredMarginPct(c.category, c.priceUsd))
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
    const picks = eligible(result.candidates);

    // ---- DRY RUN: never spends. Shows exactly what it would buy. ----
    if (!config.botLive) {
      return NextResponse.json({
        ok: true,
        mode: "DRY_RUN",
        startedAt,
        scanned: result.scanned,
        belowInsured: result.candidates.length,
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
      return NextResponse.json({ ok: true, mode: "LIVE", startedAt, eligible: 0, bought: [] });
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

    for (const c of picks) {
      if (bought.length >= config.maxBuysPerRun) break;
      // skip picks we can't afford and fall through to the next-biggest discount,
      // rather than stalling on an unaffordable top pick
      if (remainingUsdc < c.priceUsd) continue;

      recentlyAttempted.add(c.nftAddress);
      try {
        const res = await executeBuy(kp, c);
        remainingUsdc -= c.priceUsd;
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
