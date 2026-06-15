// Burner wallet helpers. The secret key lives ONLY in the CC_SNIPER_SECRET env
// var (base58, Phantom-export form) — never in code or git. The wallet's own
// balance is the hard spend cap: fund it with exactly your budget and it
// physically cannot spend more.

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import bs58 from "bs58";

// Mainnet USDC
export const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

export function getKeypair(): Keypair {
  const secret = process.env.CC_SNIPER_SECRET;
  if (!secret) throw new Error("CC_SNIPER_SECRET is not set");
  const trimmed = secret.trim();
  // accept either base58 (Phantom export) or a JSON byte array (solana CLI)
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

export function getConnection(): Connection {
  let url = process.env.CC_SNIPER_RPC_URL;
  if (!url) throw new Error("CC_SNIPER_RPC_URL is not set");
  // tolerate common paste slips: surrounding quotes/whitespace, missing scheme
  url = url.trim().replace(/^['"]|['"]$/g, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return new Connection(url, "confirmed");
}

export interface Balances {
  sol: number; // in SOL
  usdc: number; // in USDC
}

export async function getBalances(conn: Connection, owner: PublicKey): Promise<Balances> {
  const lamports = await conn.getBalance(owner);
  let usdc = 0;
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, owner);
    const bal = await conn.getTokenAccountBalance(ata);
    usdc = bal.value.uiAmount ?? 0;
  } catch {
    usdc = 0; // no USDC token account yet
  }
  return { sol: lamports / 1e9, usdc };
}
