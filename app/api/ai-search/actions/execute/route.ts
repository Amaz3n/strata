import { NextResponse } from "next/server"

import { executeAiSearchActionRequest } from "@/lib/services/ai-search/actions"
import { requireOrgContext } from "@/lib/services/context"

export const runtime = "nodejs"

function getActionId(raw: unknown) {
  if (typeof raw !== "string") return ""
  return raw.trim()
}

function getBoolean(raw: unknown) {
  if (raw === true || raw === false) return raw
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase()
    if (normalized === "true" || normalized === "1" || normalized === "yes") return true
    if (normalized === "false" || normalized === "0" || normalized === "no") return false
  }
  return false
}

function getIdempotencyKey(raw: unknown) {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    actionId?: unknown
    dryRun?: unknown
    idempotencyKey?: unknown
  }
  const actionId = getActionId(body.actionId)
  if (!actionId) {
    return NextResponse.json({ error: "actionId is required." }, { status: 400 })
  }

  try {
    const context = await requireOrgContext()
    const dryRun = getBoolean(body.dryRun)
    const action = await executeAiSearchActionRequest(context, actionId, {
      dryRun,
      idempotencyKey: getIdempotencyKey(body.idempotencyKey),
    })
    return NextResponse.json({ action })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to execute AI action."
    const status = /not found|required|invalid|ambiguous|cannot be executed|matched|expired|safety|too long/i.test(message)
      ? 400
      : 500
    return NextResponse.json({ error: message }, { status })
  }
}
