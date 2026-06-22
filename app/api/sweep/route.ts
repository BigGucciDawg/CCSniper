import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { config } from "@/lib/config";
import { getKeypair, getConnection } from "@/lib/wallet";
import { forwardNft } from "@/lib/transfer";
import { getMintCategory } from "@/lib/category";
import { fetchOwnedNfts, type OwnedNft } from "@/lib/owned";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Cap forwards per run so a big backlog of Core transfers can't blow the 60s
// Vercel limit — the every-minute cron drains the rest on the next pass.
const FORWARD_BUDGET = 12;

// Legacy enumeration: SPL token accounts only. Used ONLY as a fallback when the
// RPC can't serve DAS. BLIND to Metaplex Core (no token account) — Core slabs
// stay stuck until a DAS-capable RPC is configured.
async function listViaSplFallback(burner: PublicKey): Promise<OwnedNft[]> {
  const conn = getConnection();
  const accts = await conn.getParsedTokenAccountsByOwner(burner, {
    programId: TOKEN_PROGRAM,
  });
  const mints = accts.value
    .map((a) => a.account.data.parsed.info)
    .filter((i: any) => i.tokenAmount?.decimals === 0 && i.tokenAmount?.uiAmount === 1)
    .map((i: any) => i.mint as string);
  // Resolve category per-mint (capped so a cold start can't time out). pNFT
  // metadata-PDA path only — Core mints would resolve null here anyway.
  const out: OwnedNft[] = [];
  let lookups = 0;
  for (const mint of mints) {
    let category: string | null = null;
    try {
      if (lookups < 25) {
        category = await getMintCategory(conn, mint);
        lookups++;
      }
    } catch {
      /* unknown -> keep this run, retry next */
    }
    // name/year unused on the forward path (category decides); dedupe reads
    // holdings via DAS, not this SPL fallback.
    out.push({ mint, iface: "", isCore: false, category, cardName: null, metaName: null, year: null });
  }
  return out;
}

// Safety net: forward every forward-category NFT held by the burner to the dest
// wallet (Core + pNFT). Retries inline-forward failures + moves pre-existing
// holdings. Runs every minute via cron, so it's self-healing.
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!config.destWallet) {
    return NextResponse.json({ ok: false, error: "CC_DEST_WALLET not set" }, { status: 400 });
  }

  try {
    const kp = getKeypair();

    // Prefer DAS (sees Core + pNFT and carries the category in one call); fall
    // back to the SPL-token scan if the RPC doesn't support DAS.
    const dasNfts = await fetchOwnedNfts(kp.publicKey.toBase58());
    const viaDas = dasNfts !== null;
    const nfts = dasNfts ?? (await listViaSplFallback(kp.publicKey));

    // Only forward cards in forwardCategories (e.g. Pokemon); KEEP others (One
    // Piece supply) in the burner.
    const results: unknown[] = [];
    let kept = 0;
    let forwards = 0;
    for (const nft of nfts) {
      if (!nft.category || !config.forwardCategories.includes(nft.category)) {
        kept++;
        continue;
      }
      if (forwards >= FORWARD_BUDGET) {
        results.push({ mint: nft.mint, category: nft.category, ok: false, deferred: true });
        continue;
      }
      try {
        forwards++;
        const sig = await forwardNft(kp, nft.mint, config.destWallet);
        results.push({ mint: nft.mint, category: nft.category, iface: nft.iface, ok: true, sig });
      } catch (e: any) {
        results.push({ mint: nft.mint, category: nft.category, iface: nft.iface, ok: false, error: String(e?.message ?? e) });
      }
    }

    return NextResponse.json({
      ok: true,
      dest: config.destWallet,
      enumeration: viaDas ? "das" : "spl-fallback",
      held: nfts.length,
      forwarded: results.filter((r: any) => r.ok).length,
      deferred: results.filter((r: any) => r.deferred).length,
      kept,
      ...(viaDas ? {} : { warning: "RPC is not DAS-capable — Metaplex Core slabs are invisible and remain stuck; set a Helius/DAS RPC in CC_SNIPER_RPC_URL." }),
      results,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
