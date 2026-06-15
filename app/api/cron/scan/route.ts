import { NextRequest, NextResponse } from "next/server";
import { sweep } from "@/lib/scan";
import { ensureSchema, upsertCandidates, hasDb } from "@/lib/db";

// Always run fresh on the server; never statically optimize.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// give pagination room (Pro allows up to 300s; a Pokemon sweep is ~5-10s)
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // If no secret is configured, allow (e.g. local dev). In production you MUST
  // set CRON_SECRET so the endpoint can't be triggered by anyone.
  if (!secret) return true;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  try {
    const result = await sweep();

    let newCount = 0;
    let persisted = false;
    if (hasDb()) {
      await ensureSchema();
      newCount = await upsertCandidates(result.candidates);
      persisted = true;
    }

    return NextResponse.json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      solUsd: result.solUsd,
      scanned: result.scanned,
      belowInsured: result.candidates.length,
      newThisRun: newCount,
      persisted,
      // top deals inline so a manual hit is useful even without the DB
      top: result.candidates.slice(0, 15),
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, startedAt, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
