import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { config } from "@/lib/config";
import { getKeypair, getConnection } from "@/lib/wallet";
import { forwardNft } from "@/lib/transfer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Safety net: forward every NFT currently held by the burner to the dest wallet.
// Use to retry inline-forward failures or move pre-existing holdings.
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
    const conn = getConnection();
    const accts = await conn.getParsedTokenAccountsByOwner(kp.publicKey, { programId: TOKEN_PROGRAM });

    // NFTs: amount 1, decimals 0
    const mints = accts.value
      .map((a) => a.account.data.parsed.info)
      .filter((i: any) => i.tokenAmount?.decimals === 0 && i.tokenAmount?.uiAmount === 1)
      .map((i: any) => i.mint as string);

    const results: unknown[] = [];
    for (const mint of mints) {
      try {
        const sig = await forwardNft(kp, mint, config.destWallet);
        results.push({ mint, ok: true, sig });
      } catch (e: any) {
        results.push({ mint, ok: false, error: String(e?.message ?? e) });
      }
    }
    return NextResponse.json({ ok: true, dest: config.destWallet, held: mints.length, results });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
