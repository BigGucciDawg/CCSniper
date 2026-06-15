# cc-sniper

Collector Crypt marketplace **dry-run** deal scanner. Finds Pokémon cards listed
**below their insured value** (up to a max spend) and logs them. Runs on a Vercel
cron every minute. **This build never signs or broadcasts a transaction** — it
exists to measure whether the edge is real before any capital is risked.

## How it works

- `GET /api/cron/scan` — paginates the public Collector Crypt listing endpoint
  (`marketplaceStatus=Buy now`, `categories=Pokemon`, `listPriceMax=100`),
  converts SOL listings to USD, keeps cards where `price < insured × (1 − margin)`,
  and upserts them to Postgres. Protected by `CRON_SECRET`.
- `GET /api/candidates?limit=100` — recent finds from the DB.
- Dedupe is automatic: the `candidates` table is keyed on
  `(nft_address, price, currency)`, so a re-listing at a new price is a new row
  and the same listing seen again just bumps `last_seen`.

## Deploy (Vercel, Pro plan)

1. Import this repo into Vercel.
2. **Storage → Create Database → Neon Postgres**, connect it to the project.
   This injects `DATABASE_URL` automatically; the table is created on first run.
3. **Settings → Environment Variables → add `CRON_SECRET`** (`openssl rand -hex 32`).
   Vercel sends it as a Bearer header on every cron invocation.
4. Deploy. The cron in [`vercel.json`](./vercel.json) fires `* * * * *` (every
   minute — requires the **Pro** plan; Hobby is limited to once/day).

Until the DB is connected the cron still runs and returns the deals it found in
the JSON response — it just doesn't persist them.

## Tuning (env vars, no redeploy needed for value changes)

| Var | Default | Meaning |
|-----|---------|---------|
| `CC_MAX_SPEND_USD` | `100` | Ignore listings above this |
| `CC_MIN_MARGIN` | `0` | Require `price ≤ insured × (1 − margin)`. Raise to ~`0.12–0.15` before going live so the 2% fee + gas don't eat the edge |
| `CC_CATEGORIES` | `Pokemon` | Comma-separated category allowlist |
| `CC_MIN_INSURED_USD` | `1` | Ignore dust / placeholder insured values |

## Caveats

- **Latency**: cron runs at most once/minute and the listing endpoint is cached
  ~60s server-side, so freshly-listed hot snipes can be lost to faster bots.
  Fine for persistent below-insured inventory (sealed product, graded singles).
- **Insured value ≠ resale value**. Validate against secondary-market comps
  before trusting the spread.

## Phase 2 (not built)

Live executor: `POST /marketplace/buy` → sign with a funded **burner** keypair
(`CC_SNIPER_SECRET`, base58) → `POST /marketplace/broadcast`, plus a daily spend
cap, idempotency, and priority fees. Validate the dry-run data first.
