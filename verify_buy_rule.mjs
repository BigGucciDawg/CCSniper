// Adversarial verification of the NEW Pokemon buy rule against LIVE Collector Crypt data.
// Node 24 global fetch, no auth.
// In the API, each entry in filterNFtCard IS the card (flat fields: category, type,
// insuredValue, itemName, nftAddress) with a nested `listing` { currency, price }.

const BLACKLIST = new Set(["ghSZnm9k1VQtw9JCdwnYH5My587ePsPextg6JfZ7zKf"]);

const base =
  "https://api.collectorcrypt.com/marketplace?marketplaceStatus=Buy%20now&marketplaceSource=CC&categories=Pokemon&listPriceMax=350&orderBy=listedDateDesc&step=100";

async function getPage(n, attempt = 1) {
  const url = `${base}&page=${n}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt < 4) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return getPage(n, attempt + 1);
    }
    throw e;
  }
}

async function main() {
  const first = await getPage(1);
  const totalPages = Number(first.totalPages) || 1;

  const pages = [first];
  for (let p = 2; p <= totalPages; p++) {
    pages.push(await getPage(p));
  }

  let pokemonScanned = 0; // total Card+USDC with insured>0 seen
  const eligible = [];
  let blacklistSkipped = 0;
  let totalItems = 0;

  // adversarial counters
  let anyInsuredAtOrAbove50 = 0;
  let anyAtOrAboveInsured = 0;
  let anyNonPokemon = 0;

  for (const page of pages) {
    const items = page.filterNFtCard || [];
    totalItems += items.length;
    for (const card of items) {
      const listing = card.listing || {};

      const price = Number(listing.price);
      const insured = Number(card.insuredValue);
      const currency = listing.currency;
      const type = card.type;
      const category = card.category;
      const mint = card.nftAddress || "";

      // "pokemonScanned" = total Card+USDC with insured>0 seen
      if (type === "Card" && currency === "USDC" && insured > 0) {
        pokemonScanned++;
      }

      // blacklist
      if (mint && BLACKLIST.has(mint)) {
        blacklistSkipped++;
        continue;
      }

      // NEW RULE: eligible = ALL of
      const passes =
        type === "Card" &&
        currency === "USDC" &&
        insured > 0 &&
        insured < 50 &&
        price < insured;

      if (passes) {
        const disc = (100 * (insured - price)) / insured;
        const name = (card.itemName || card.name || "").toString();
        eligible.push({ price, insured, disc, name, category, mint });

        // adversarial re-checks on the eligible set
        if (insured >= 50) anyInsuredAtOrAbove50++;
        if (price >= insured) anyAtOrAboveInsured++;
        if (category !== "Pokemon") anyNonPokemon++;
      }
    }
  }

  eligible.sort((a, b) => b.disc - a.disc);

  const samples = eligible.slice(0, 8).map((e) => {
    const nm = (e.name || "").slice(0, 30);
    return `$${e.price} insured $${e.insured} (-${e.disc.toFixed(1)}%) ${nm}`;
  });

  const insuredVals = eligible.map((e) => e.insured);
  const priceVals = eligible.map((e) => e.price);
  const minInsured = insuredVals.length ? Math.min(...insuredVals) : null;
  const maxInsured = insuredVals.length ? Math.max(...insuredVals) : null;
  const minPrice = priceVals.length ? Math.min(...priceVals) : null;
  const maxPrice = priceVals.length ? Math.max(...priceVals) : null;

  const ok =
    anyInsuredAtOrAbove50 === 0 &&
    anyAtOrAboveInsured === 0 &&
    anyNonPokemon === 0;

  const out = {
    totalPages,
    totalItems,
    blacklistSkipped,
    pokemonScanned,
    eligible: eligible.length,
    samples,
    anyInsuredAtOrAbove50,
    anyAtOrAboveInsured,
    anyNonPokemon,
    ok,
    insuredRange: [minInsured, maxInsured],
    priceRange: [minPrice, maxPrice],
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
