import { NextResponse } from "next/server"

import { completePlatformBugAiReview } from "@/lib/services/platform-bugs"

export const runtime = "nodejs"

function getText(value: unknown) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export async function POST(request: Request) {
  const secret = process.env.CODEX_REVIEW_CALLBACK_SECRET?.trim()
  const auth = request.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : ""

  if (!secret || token !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    review_id?: unknown
    bug_id?: unknown
    status?: unknown
    output?: unknown
    error?: unknown
    github_run_id?: unknown
    github_run_url?: unknown
  }

  const reviewId = getText(body.review_id)
  const bugId = getText(body.bug_id)
  const rawStatus = getText(body.status)
  const status = rawStatus === "failed" ? "failed" : "proposal_ready"

  if (!reviewId || !bugId) {
    return NextResponse.json({ error: "review_id and bug_id are required." }, { status: 400 })
  }

  try {
    const review = await completePlatformBugAiReview({
      reviewId,
      bugId,
      status,
      output: getText(body.output),
      error: getText(body.error),
      githubRunId: getText(body.github_run_id),
      githubRunUrl: getText(body.github_run_url),
    })
    return NextResponse.json({ review })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save AI review."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
