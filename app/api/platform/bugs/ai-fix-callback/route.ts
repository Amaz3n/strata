import { NextResponse } from "next/server"

import { completePlatformBugAiFix } from "@/lib/services/platform-bugs"

export const runtime = "nodejs"

function getText(value: unknown) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function getNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

export async function POST(request: Request) {
  const secret = process.env.CODEX_REVIEW_CALLBACK_SECRET?.trim()
  const auth = request.headers.get("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : ""

  if (!secret || token !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    fix_id?: unknown
    bug_id?: unknown
    status?: unknown
    output?: unknown
    error?: unknown
    github_run_id?: unknown
    github_run_url?: unknown
    branch_name?: unknown
    commit_sha?: unknown
    pr_number?: unknown
    pr_url?: unknown
  }

  const fixId = getText(body.fix_id)
  const bugId = getText(body.bug_id)
  const rawStatus = getText(body.status)
  const status = rawStatus === "failed" ? "failed" : "pr_ready"

  if (!fixId || !bugId) {
    return NextResponse.json({ error: "fix_id and bug_id are required." }, { status: 400 })
  }

  try {
    const fix = await completePlatformBugAiFix({
      fixId,
      bugId,
      status,
      output: getText(body.output),
      error: getText(body.error),
      githubRunId: getText(body.github_run_id),
      githubRunUrl: getText(body.github_run_url),
      branchName: getText(body.branch_name),
      commitSha: getText(body.commit_sha),
      prNumber: getNumber(body.pr_number),
      prUrl: getText(body.pr_url),
    })
    return NextResponse.json({ fix })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save AI fix."
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
