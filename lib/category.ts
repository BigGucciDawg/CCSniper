// Resolve a held NFT's Collector Crypt category (e.g. "Pokemon" / "One Piece")
// from its on-chain Metaplex metadata -> off-chain JSON attributes. A bought
// card is delisted, so the marketplace API can't tell us anymore; the metadata
// can. Results are cached forever (a mint's category never changes), so the
// forwarder doesn't re-fetch the growing kept-in-burner pile every run.

import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const cache = new Map<string, string>();

function metadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), TOKEN_METADATA.toBuffer(), mint.toBuffer()],
    TOKEN_METADATA
  )[0];
}

// parse the `uri` out of a Metaplex Metadata account (after key+authority+mint,
// then borsh strings name, symbol, uri)
function parseUri(data: Buffer): string {
  let o = 1 + 32 + 32;
  for (let i = 0; i < 2; i++) {
    const len = data.readUInt32LE(o);
    o += 4 + len; // skip name, then symbol
  }
  const len = data.readUInt32LE(o);
  o += 4;
  return data.slice(o, o + len).toString("utf8").replace(/\0/g, "").trim();
}

export async function getMintCategory(conn: Connection, mint: string): Promise<string | null> {
  const cached = cache.get(mint);
  if (cached !== undefined) return cached;

  const acc = await conn.getAccountInfo(metadataPda(new PublicKey(mint)));
  if (!acc) return null;
  const uri = parseUri(acc.data);
  if (!uri) return null;

  const json: any = await (await fetch(uri)).json();
  const attr = (json?.attributes ?? []).find(
    (a: any) => String(a?.trait_type ?? "").toLowerCase() === "category"
  );
  const category = attr?.value ? String(attr.value) : null;
  if (category) cache.set(mint, category);
  return category;
}
