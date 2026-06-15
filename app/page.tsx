export default function Home() {
  return (
    <main style={{ maxWidth: 720, lineHeight: 1.6 }}>
      <h1>cc-sniper</h1>
      <p>
        Collector Crypt below-insured-value deal scanner (dry-run). Runs on a
        Vercel cron every minute and logs candidates to Postgres.
      </p>
      <ul>
        <li>
          <code>GET /api/cron/scan</code> — one sweep (cron-triggered; protected
          by <code>CRON_SECRET</code>).
        </li>
        <li>
          <code>GET /api/candidates?limit=100</code> — recent finds from the DB.
        </li>
      </ul>
      <p style={{ opacity: 0.6 }}>
        Dry-run only — this build never signs or broadcasts a transaction.
      </p>
    </main>
  );
}
