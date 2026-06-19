// Adversarial verification of NEW buy rules against LIVE Collector Crypt data.
// Node 24 global fetch. Public CC API, no auth.

const BASE = "https://api.collectorcrypt.com/marketplace";

async function fetchPage(cat, max, page) {
  const url = `${BASE}?marketplaceStatus=${encodeURIComponent("Buy now")}&marketplaceSource=CC&categories=${encodeURIComponent(cat)}&listPriceMax=${max}&orderBy=listedDateDesc&page=${page}&step=100`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        if (attempt === 3) throw new Error(`HTTP ${res.status} for ${cat} page ${page}`);
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      return await res.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

async function fetchAll(cat, max) {
  const first = await fetchPage(cat, max, 1);
  const totalPages = Number(first?.totalPages ?? 1);
  let rows = Array.isArray(first?.filterNFtCard) ? first.filterNFtCard.slice() : [];
  for (let p = 2; p <= totalPages; p++) {
    const d = await fetchPage(cat, max, p);
    if (Array.isArray(d?.filterNFtCard)) rows = rows.concat(d.filterNFtCard);
  }
  return { rows, totalPages };
}

function name30(item) {
  const n = item?.nftName ?? item?.name ?? item?.cardName ?? item?.itemName ?? item?.title ?? "";
  return String(n).slice(0, 30);
}

// Each marketplace row: top-level fields are card; `listing` carries price/currency.
function extract(item) {
  const listing = item.listing ?? item.Listing ?? item;
  const price = Number(listing.price);
  const insured = Number(item.insuredValue ?? item.insuredvalue ?? item.insured_value);
  const currency = listing.currency ?? listing.Currency;
  const type = item.type ?? item.category ?? item.Type;
  const discountPct = insured > 0 ? (100 * (insured - price)) / insured : -Infinity;
  return { price, insured, currency, type, discountPct, name: name30(item) };
}

function evalCommon(e) {
  return (
    e.type === "Card" &&
    e.currency === "USDC" &&
    e.insured > 0 &&
    Number.isFinite(e.price) &&
    e.price <= e.insured
  );
}

function fmtSample(e) {
  return `$${e.price} ins $${e.insured} (-${e.discountPct.toFixed(1)}%) ${e.name}`;
}

(async () => {
  const notes = [];

  // ---- One Piece: price<=200 AND discountPct>=10 (MAX=200) ----
  const op = await fetchAll("One Piece", 200);
  notes.push(`OnePiece fetched ${op.rows.length} rows across ${op.totalPages} pages.`);
  const opEx = op.rows.map(extract);
  const opEligible = opEx.filter((e) => evalCommon(e) && e.price <= 200 && e.discountPct >= 10);
  const opEligibleSealed = opEx.filter(
    (e) =>
      e.type !== "Card" &&
      e.currency === "USDC" &&
      e.insured > 0 &&
      Number.isFinite(e.price) &&
      e.price <= e.insured &&
      e.price <= 200 &&
      e.discountPct >= 10
  );
  const onePieceSamples = opEligible
    .slice()
    .sort((a, b) => b.discountPct - a.discountPct)
    .slice(0, 5)
    .map(fmtSample);
  const onePieceAnyAbove200 = opEligible.filter((e) => e.price > 200).length;

  // ---- Pokemon: price>=100 AND discountPct>=15 (MAX=350) ----
  const pk = await fetchAll("Pokemon", 350);
  notes.push(`Pokemon fetched ${pk.rows.length} rows across ${pk.totalPages} pages.`);
  const pkEx = pk.rows.map(extract);
  const pkEligible = pkEx.filter((e) => evalCommon(e) && e.price >= 100 && e.discountPct >= 15);
  const pkEligibleSealed = pkEx.filter(
    (e) =>
      e.type !== "Card" &&
      e.currency === "USDC" &&
      e.insured > 0 &&
      Number.isFinite(e.price) &&
      e.price <= e.insured &&
      e.price >= 100 &&
      e.discountPct >= 15
  );
  const pokemonSamples = pkEligible
    .slice()
    .sort((a, b) => b.discountPct - a.discountPct)
    .slice(0, 5)
    .map(fmtSample);
  const pokemonAnyBelow100 = pkEligible.filter((e) => e.price < 100).length;

  // ---- cross-cutting invariants ----
  const allEligible = [...opEligible, ...pkEligible];
  const anyEligibleAboveInsured = allEligible.filter((e) => e.price > e.insured).length;
  const sealedEligible = opEligibleSealed.length + pkEligibleSealed.length;

  const ok = onePieceAnyAbove200 === 0 && pokemonAnyBelow100 === 0 && anyEligibleAboveInsured === 0;

  // currency distribution sanity
  const opCur = {};
  opEx.forEach((e) => (opCur[e.currency] = (opCur[e.currency] || 0) + 1));
  const pkCur = {};
  pkEx.forEach((e) => (pkCur[e.currency] = (pkCur[e.currency] || 0) + 1));
  const opTypes = {};
  opEx.forEach((e) => (opTypes[e.type] = (opTypes[e.type] || 0) + 1));
  const pkTypes = {};
  pkEx.forEach((e) => (pkTypes[e.type] = (pkTypes[e.type] || 0) + 1));
  notes.push(`OP currency=${JSON.stringify(opCur)} types=${JSON.stringify(opTypes)}.`);
  notes.push(`PK currency=${JSON.stringify(pkCur)} types=${JSON.stringify(pkTypes)}.`);
  notes.push(`OP sealed-eligible=${opEligibleSealed.length}, PK sealed-eligible=${pkEligibleSealed.length}.`);

  const out = {
    onePieceEligible: opEligible.length,
    onePieceSamples,
    onePieceAnyAbove200,
    pokemonEligible: pkEligible.length,
    pokemonSamples,
    pokemonAnyBelow100,
    anyEligibleAboveInsured,
    sealedEligible,
    ok,
    notes: notes.join(" "),
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
