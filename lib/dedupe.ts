// Card-identity helpers for "don't buy a card we already hold."
//
// A duplicate is judged by CARD identity, NOT by the physical slab: two
// different graded copies of the same card are duplicates. Per operator: ANY
// grade counts — once we hold a card, skip every other copy regardless of
// grade/condition. The identity is therefore name-core + year:
//   - GRADE is excluded on purpose (any grade is a dup).
//   - SET is excluded on purpose — the marketplace set string
//     ("Paradox Rift - PAR EN - English") and the on-chain slab's Set attribute
//     ("Pokemon Obf EN-Obsidian Flames") use different formats, so keying on it
//     would MISS duplicates. Name+year is reliably present and comparable on
//     both sides. The (rare) cost is treating two same-name/same-year cards
//     from different sets as one — acceptable, and aligned with "one is enough."

/** Lowercase, strip punctuation, collapse whitespace → a stable comparison core. */
export function normalizeName(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract the card NAME from a marketplace `itemName`, which is formatted
 * "{year} #{number} {NAME} {GRADE-LABEL} {COMPANY} {gradeNum} {set…} Pokemon",
 * e.g. "2023 #251 Roaring Moon EX CGC 10 Par EN-Paradox Rift Pokemon". The name
 * always precedes the grading-company token, so we strip the leading year/number
 * and cut at the company. Ungraded items (no company) keep the trailing text —
 * fine, since they're compared against the same parse.
 */
export function listingNameCore(itemName: string | null | undefined): string {
  let s = String(itemName ?? "");
  s = s.replace(/^\s*\d{4}\s+/, ""); // leading year
  s = s.replace(/^\s*#\S+\s+/, ""); // leading "#number"
  // cut at the grading company token (PSA/CGC/BGS/SGC/TAG/ACE/HGA)
  s = s.split(/\s+(?:PSA|CGC|BGS|SGC|TAG|ACE|HGA)\b/i)[0]!;
  return normalizeName(s);
}

/**
 * Extract the card NAME from an on-chain slab. Prefer the clean "Card Name"
 * attribute; fall back to parsing the (truncated) metadata name the same way as
 * a listing so both sides normalize identically.
 */
export function heldNameCore(
  cardNameAttr: string | null | undefined,
  metaName: string | null | undefined,
): string {
  const fromAttr = normalizeName(cardNameAttr);
  if (fromAttr) return fromAttr;
  return listingNameCore(metaName);
}

/** Grade-agnostic card identity: name-core + "|" + year. */
export function cardKey(
  nameCore: string,
  year: string | number | null | undefined,
): string {
  const y = year == null ? "" : String(year).trim();
  return `${nameCore}|${y}`;
}
