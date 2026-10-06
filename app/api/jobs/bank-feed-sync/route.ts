import { type NextRequest, NextResponse } from "next/server"

import { processPendingBankFeedEvents } from "@/lib/services/books/bank-feeds"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { processBankAiSuggestionBacklog } from "@/lib/services/books/bank-ai-suggestions"

export const maxDuration = 300

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const aiDeadline = Date.now() + 180_000
  const result = await processPendingBankFeedEvents()
  let aiSuggestions = { assessed: 0, failed: 0 }
  try {
    aiSuggestions = await processBankAiSuggestionBacklog({ maxOrgs: 5, deadline: aiDeadline })
  } catch (error) {
    console.error("[banking-ai] Scheduled suggestion backlog failed", error)
  }
  return NextResponse.json(
    { ok: result.failures.length === 0, ...result, aiSuggestions },
    { status: result.failures.length === 0 ? 200 : 207 },
  )
}

export const GET = withCronRun("bank-feed-sync", handler)
