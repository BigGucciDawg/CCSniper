// Enumerate the NFTs a wallet holds via the Helius DAS API (getAssetsByOwner).
//
// WHY NOT getParsedTokenAccountsByOwner: that only lists SPL Token accounts, so
// it is BLIND to Metaplex Core assets (CC's newer slabs) — they have no token
// account. DAS returns BOTH standards plus the off-chain `category` attribute in
// one call, so it doubles as the category source (no per-mint URI fetch needed).
//
// Returns null when the RPC doesn't speak DAS / the call fails, so the caller
// can fall back to the legacy SPL-token enumeration (pNFTs only).

export interface OwnedNft {
  mint: string;
  /** DAS interface: "MplCoreAsset" | "ProgrammableNFT" | "V1_NFT" | … */
  iface: string;
  isCore: boolean;
  /** Collector Crypt "Category" trait ("Pokemon" / "One Piece" / …), or null. */
  category: string | null;
  /** "Card Name" attribute (may be bare, e.g. "Shaymin"), for dedupe. */
  cardName: string | null;
  /** On-chain metadata name (truncated) — dedupe name fallback. */
  metaName: string | null;
  /** "Year" attribute, for dedupe. */
  year: string | null;
}

interface DasAttribute {
  trait_type?: string;
  value?: string;
}
interface DasAsset {
  id: string;
  interface?: string;
  burnt?: boolean;
  compression?: { compressed?: boolean };
  content?: { metadata?: { name?: string; attributes?: DasAttribute[] } };
}

function rpcUrl(): string {
  let url = (process.env.CC_SNIPER_RPC_URL || "").trim().replace(/^['"]|['"]$/g, "");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

function attrOf(asset: DasAsset, trait: string): string | null {
  const a = asset.content?.metadata?.attributes?.find(
    (x) => (x.trait_type ?? "").toLowerCase() === trait.toLowerCase(),
  );
  return a?.value != null && a.value !== "" ? String(a.value) : null;
}

/**
 * All non-burnt, non-compressed NFTs (Core + pNFT/NFT, excluding fungibles)
 * owned by `owner`, with their standard and CC category. Returns null if DAS is
 * unavailable so the caller can degrade to the legacy SPL enumeration.
 */
export async function fetchOwnedNfts(owner: string): Promise<OwnedNft[] | null> {
  const url = rpcUrl();
  const out: OwnedNft[] = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "cc-owned",
          method: "getAssetsByOwner",
          params: { ownerAddress: owner, page, limit: 1000 },
        }),
      });
      if (!r.ok) return null; // RPC rejected DAS → signal fallback
      const j = (await r.json()) as {
        result?: { items?: DasAsset[] };
        error?: { message?: string };
      };
      if (j.error) return null; // method not supported → signal fallback
      const items = j.result?.items ?? [];
      for (const a of items) {
        const iface = a.interface ?? "";
        // NFTs only — skip fungible tokens (USDC, etc.) and compressed/burnt.
        if (a.burnt || a.compression?.compressed) continue;
        if (iface.includes("Fungible")) continue;
        out.push({
          mint: a.id,
          iface,
          isCore: iface === "MplCoreAsset",
          category: attrOf(a, "category"),
          cardName: attrOf(a, "card name"),
          metaName: a.content?.metadata?.name ?? null,
          year: attrOf(a, "year"),
        });
      }
      if (items.length < 1000) break; // last page
    }
  } catch {
    return null; // network / parse error → signal fallback
  }
  return out;
}

/**
 * Build the set of grade-agnostic card keys (name+year) we ALREADY hold across
 * the given owners (treasury + burner — the burner catches just-bought cards
 * not yet forwarded). Restricted to `categories` (e.g. Pokemon) so a category we
 * intentionally accumulate as supply (One Piece) is never deduped.
 *
 * Returns null if DAS is unavailable for ANY owner — the caller then proceeds
 * WITHOUT dedupe rather than halting all buying on a transient RPC hiccup.
 */
export async function fetchHeldCardKeys(
  owners: string[],
  categories: string[],
): Promise<Set<string> | null> {
  const { cardKey, heldNameCore } = await import("./dedupe");
  const cats = categories.map((c) => c.toLowerCase());
  const keys = new Set<string>();
  for (const owner of owners) {
    const nfts = await fetchOwnedNfts(owner);
    if (nfts === null) return null; // DAS down → skip dedupe this run
    for (const n of nfts) {
      if (!n.category || !cats.includes(n.category.toLowerCase())) continue;
      const core = heldNameCore(n.cardName, n.metaName);
      if (!core) continue;
      keys.add(cardKey(core, n.year));
    }
  }
  return keys;
}
