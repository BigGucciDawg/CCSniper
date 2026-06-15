// Durable deal log in Neon Postgres (Vercel's first-class Postgres integration).
// Replaces the local candidates.csv. Dedupe is free: upsert keyed on
// (nft_address, price, currency) — a re-listing at a new price = a new row,
// the same listing seen again just bumps last_seen.
//
// If DATABASE_URL is not set yet (DB not connected), hasDb() is false and the
// cron route runs in preview mode (finds deals, returns them, persists nothing).

import { neon } from "@neondatabase/serverless";
import type { Candidate } from "./scan";

const DB_URL =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  "";

export function hasDb(): boolean {
  return Boolean(DB_URL);
}

function client() {
  if (!DB_URL) throw new Error("No DATABASE_URL / POSTGRES_URL configured");
  return neon(DB_URL);
}

let schemaReady = false;

export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const sql = client();
  await sql`
    CREATE TABLE IF NOT EXISTS candidates (
      nft_address     text        NOT NULL,
      price           numeric      NOT NULL,
      currency        text         NOT NULL,
      card_id         text,
      category        text,
      item_name       text,
      grade           text,
      grading_company text,
      price_usd       numeric,
      insured_usd     numeric,
      spread_usd      numeric,
      spread_pct      numeric,
      listed_at       timestamptz,
      owner_wallet    text,
      url             text,
      first_seen      timestamptz NOT NULL DEFAULT now(),
      last_seen       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (nft_address, price, currency)
    )
  `;
  schemaReady = true;
}

// Returns how many of these were brand-new (inserted) vs. already seen.
export async function upsertCandidates(cands: Candidate[]): Promise<number> {
  if (cands.length === 0) return 0;
  const sql = client();
  let inserted = 0;
  // neon http driver: one round-trip per row is fine at this volume (~hundreds)
  for (const c of cands) {
    const rows = await sql`
      INSERT INTO candidates (
        nft_address, price, currency, card_id, category, item_name, grade,
        grading_company, price_usd, insured_usd, spread_usd, spread_pct,
        listed_at, owner_wallet, url
      ) VALUES (
        ${c.nftAddress}, ${c.price}, ${c.currency}, ${c.cardId}, ${c.category},
        ${c.itemName}, ${c.grade}, ${c.gradingCompany}, ${c.priceUsd},
        ${c.insuredUsd}, ${c.spreadUsd}, ${c.spreadPct}, ${c.listedAt},
        ${c.ownerWallet}, ${c.url}
      )
      ON CONFLICT (nft_address, price, currency)
      DO UPDATE SET last_seen = now()
      RETURNING (xmax = 0) AS inserted
    `;
    if (rows[0]?.inserted) inserted++;
  }
  return inserted;
}

export async function recentCandidates(limit = 100): Promise<any[]> {
  const sql = client();
  return sql`
    SELECT nft_address, item_name, category, grade, currency, price, price_usd,
           insured_usd, spread_usd, spread_pct, listed_at, first_seen, url
    FROM candidates
    ORDER BY first_seen DESC
    LIMIT ${limit}
  `;
}
