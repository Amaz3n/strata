import { type NextRequest, NextResponse } from "next/server"

import { runBooksProjection } from "@/lib/services/books/projector"
import { withCronRun } from "@/lib/services/job-runs"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const expected = process.env.CRON_SECRET
  const bearer = request.headers.get("authorization")
  if (expected) return bearer === `Bearer ${expected}` || request.headers.get("x-cron-secret") === expected
  return request.headers.get("x-vercel-cron") === "1"
}

async function handler(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const result = await runBooksProjection()
  const failures = result.results.reduce((sum, item) => sum + item.failures.length, 0)
  return NextResponse.json({ ok: failures === 0, failures, ...result }, { status: failures === 0 ? 200 : 207 })
}

export const GET = withCronRun("books-projection", handler)
