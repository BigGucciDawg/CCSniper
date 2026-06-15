import { NextRequest, NextResponse } from "next/server";
import { hasDb, recentCandidates } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Read-only view of the most recent finds (just our computed deal log).
export async function GET(req: NextRequest) {
  if (!hasDb()) {
    return NextResponse.json({ ok: false, error: "no database configured" }, { status: 503 });
  }
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 500);
  try {
    const rows = await recentCandidates(limit);
    return NextResponse.json({ ok: true, count: rows.length, rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
