// The 3-step Collector Crypt buy flow, isolated so the cron route stays readable:
//   1. POST /marketplace/buy   -> raw base64 unsigned tx (CC pre-signs the fee payer)
//   2. sign locally with the burner keypair (fills the buyer's signature slot)
//   3. POST /marketplace/broadcast -> { success, signature, message }

import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config";
import type { Candidate } from "./scan";

async function buildBuyTx(wallet: string, c: Candidate): Promise<string> {
  const res = await fetch(`${config.apiBase}/marketplace/buy`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": config.userAgent },
    body: JSON.stringify({
      wallet,
      nftAddress: c.nftAddress,
      price: c.price,
      currency: c.currency,
    }),
  });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`buy build failed ${res.status}: ${text.slice(0, 200)}`);
  // endpoint returns the base64 tx directly (not JSON-wrapped)
  return text;
}

function signTx(b64: string, kp: Keypair): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  // sign([kp]) fills only our signature slot; CC's pre-signed slot is preserved
  tx.sign([kp]);
  return Buffer.from(tx.serialize()).toString("base64");
}

export interface BroadcastResult {
  success?: boolean;
  signature?: string;
  message?: string;
  [k: string]: unknown;
}

async function broadcast(wallet: string, signedTx: string, nftAddress: string): Promise<BroadcastResult> {
  const res = await fetch(`${config.apiBase}/marketplace/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": config.userAgent },
    body: JSON.stringify({ wallet, signedTransaction: signedTx, nftAddress }),
  });
  const text = await res.text();
  let parsed: BroadcastResult;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { message: text };
  }
  if (!res.ok) throw new Error(`broadcast failed ${res.status}: ${text.slice(0, 200)}`);
  return parsed;
}

// Full buy. Returns the broadcast result (incl. tx signature). Throws on failure.
export async function executeBuy(kp: Keypair, c: Candidate): Promise<BroadcastResult> {
  const wallet = kp.publicKey.toBase58();
  const unsigned = await buildBuyTx(wallet, c);
  const signed = signTx(unsigned, kp);
  return broadcast(wallet, signed, c.nftAddress);
}
