// Forward a bought NFT from the burner to the destination wallet.
// Collector Crypt cards are programmable NFTs (pNFTs, tokenStandard 4), which
// are frozen — a plain SPL transfer fails. We use Metaplex transferV1, which
// handles token records and (re)creating the destination token account. The
// tokenStandard and any authorization rule set are read from the asset itself,
// so this also works for regular NFTs.

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
import { mplToolbox } from "@metaplex-foundation/mpl-toolbox";
import type { Keypair } from "@solana/web3.js";

function makeUmi(burner: Keypair) {
  const rpc = (process.env.CC_SNIPER_RPC_URL || "").trim().replace(/^['"]|['"]$/g, "");
  const url = /^https?:\/\//i.test(rpc) ? rpc : `https://${rpc}`;
  const umi = createUmi(url).use(mplTokenMetadata()).use(mplToolbox());
  const kp = umi.eddsa.createKeypairFromSecretKey(burner.secretKey);
  umi.use(signerIdentity(createSignerFromKeypair(umi, kp)));
  return umi;
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
    destinationOwner: publicKey(destOwner),
    tokenStandard: std,
    authorizationRules,
  });

  const res = await builder.sendAndConfirm(umi, {
    confirm: { commitment: "confirmed" },
    send: { skipPreflight: false },
  });

  // umi returns the signature as bytes; encode to base58
  const { base58 } = await import("@metaplex-foundation/umi/serializers");
  return base58.deserialize(res.signature)[0];
}
