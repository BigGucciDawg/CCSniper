// Forward a bought NFT from the burner to the destination wallet.
//
// Collector Crypt mints in TWO on-chain standards and we must handle both:
//   - OLDER slabs are programmable NFTs (pNFTs, tokenStandard 4) — frozen, so a
//     plain SPL transfer fails. Metaplex Token Metadata `transferV1` handles
//     token records + (re)creating the destination token account, reading the
//     tokenStandard + rule set from the asset (works for regular NFTs too).
//   - NEWER slabs are Metaplex Core (`MplCoreAsset`) — single-account assets
//     with NO token account and NO Token Metadata PDA, transferred via the
//     mpl-core program's own `transferV1` (asset + optional collection +
//     newOwner). `fetchDigitalAsset` THROWS on these, so the old pNFT-only
//     forwarder left every Core slab stuck in the burner.
//
// We detect the standard first (mpl-core `fetchAsset` only deserializes Core
// assets) and route to the matching transfer — mirrors the gym treasury's
// dual-path nftTransfer.ts.

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  createSignerFromKeypair,
  signerIdentity,
  publicKey,
  type PublicKey,
} from "@metaplex-foundation/umi";
import {
  transferV1,
  fetchDigitalAsset,
  TokenStandard,
  mplTokenMetadata,
} from "@metaplex-foundation/mpl-token-metadata";
import {
  mplCore,
  fetchAsset,
  transferV1 as coreTransferV1,
  collectionAddress,
  type AssetV1,
} from "@metaplex-foundation/mpl-core";
import { mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import type { Keypair } from "@solana/web3.js";

function makeUmi(burner: Keypair) {
  const rpc = (process.env.CC_SNIPER_RPC_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const url = /^https?:\/\//i.test(rpc) ? rpc : `https://${rpc}`;
  const umi = createUmi(url).use(mplTokenMetadata()).use(mplToolbox()).use(mplCore());
  const kp = umi.eddsa.createKeypairFromSecretKey(burner.secretKey);
  umi.use(signerIdentity(createSignerFromKeypair(umi, kp)));
  return umi;
}

async function encodeSig(signature: Uint8Array): Promise<string> {
  const { base58 } = await import("@metaplex-foundation/umi/serializers");
  return base58.deserialize(signature)[0];
}

// Transfers `mint` from the burner (umi identity) to `destOwner`. Returns the
// base58 transaction signature. Throws on failure.
export async function forwardNft(
  burner: Keypair,
  mint: string,
  destOwner: string
): Promise<string> {
  const umi = makeUmi(burner);
  const mintPk = publicKey(mint);
  const dest = publicKey(destOwner);

  // Detect Metaplex Core first — `fetchAsset` deserializes ONLY Core assets, so
  // success here means it's a Core slab (a pNFT/NFT throws and falls through).
  let coreAsset: AssetV1 | undefined;
  try {
    coreAsset = await fetchAsset(umi, mintPk);
  } catch {
    coreAsset = undefined; // not a Core asset → Token Metadata path below
  }

  // ---- Metaplex Core transfer (CC's newer slabs) ----
  if (coreAsset) {
    // Pass the collection (if any) so the program's royalty/plugin lifecycle
    // checks run; authority + payer default to the umi identity (the burner).
    const res = await coreTransferV1(umi, {
      asset: mintPk,
      collection: collectionAddress(coreAsset),
      newOwner: dest,
    }).sendAndConfirm(umi, {
      confirm: { commitment: "confirmed" },
      send: { skipPreflight: false },
    });
    return encodeSig(res.signature);
  }

  // ---- Token Metadata (pNFT / NFT) transfer (CC's older slabs) ----
  // read the asset to get its token standard + any programmable rule set
  const asset = await fetchDigitalAsset(umi, mintPk);
  const tokenStandard = asset.metadata.tokenStandard;
  const std =
    tokenStandard.__option === "Some" ? tokenStandard.value : TokenStandard.NonFungible;

  // pNFTs may carry an authorization rule set that must be passed through
  let authorizationRules: PublicKey | undefined;
  const pc = asset.metadata.programmableConfig;
  if (pc.__option === "Some" && pc.value.ruleSet.__option === "Some") {
    authorizationRules = pc.value.ruleSet.value;
  }

  const builder = transferV1(umi, {
    mint: mintPk,
    authority: umi.identity,
    tokenOwner: umi.identity.publicKey,
    destinationOwner: dest,
    tokenStandard: std,
    authorizationRules,
  });

  const res = await builder.sendAndConfirm(umi, {
    confirm: { commitment: "confirmed" },
    send: { skipPreflight: false },
  });

  return encodeSig(res.signature);
}
