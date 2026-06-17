import { NextResponse } from "next/server"

import { executeAiWorkflow } from "@/lib/services/ai-search/workflows"
import { requireOrgContext } from "@/lib/services/context"

export const runtime = "nodejs"

function getText(raw: unknown) {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    workflowId?: unknown
  }
  const workflowId = getText(body.workflowId)
  if (!workflowId) {
    return NextResponse.json({ error: "workflowId is required." }, { status: 400 })
  }

  try {
    const context = await requireOrgContext()
    const workflow = await executeAiWorkflow(context, workflowId)
    return NextResponse.json({ workflow })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to execute workflow."
    const status = /not found|required|invalid|expired|ready|permission|authorization|email/i.test(message) ? 400 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
