import { NextRequest } from "next/server"

import { logger } from "@/lib/logging/logger"
import { streamAiAssistant } from "@/lib/services/ai-assistant/harness"
import { aiAssistantSseEventSchema } from "@/lib/validation/ai-assistant"

export const runtime = "nodejs"
const MAX_QUERY_CHARS = 1_200

type StreamPayload = {
  query: string
  limit?: number
  sessionId?: string
  mode?: "org" | "general"
  currentProjectId?: string
}

function toSseEvent(event: string, data: unknown) {
  aiAssistantSseEventSchema.parse({ event, data })
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function parseLimit(raw: unknown) {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.floor(raw)
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function parseSessionId(raw: unknown) {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseMode(raw: unknown): "org" | "general" | undefined {
  if (raw !== "org" && raw !== "general") return undefined
  return raw
}

function parseProjectId(raw: unknown) {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(trimmed)
    ? trimmed
    : undefined
}

function buildStreamResponse(request: NextRequest, payload: StreamPayload) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // no-op
        }
      }

      const send = (event: string, payload: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(toSseEvent(event, payload)))
        } catch {
          close()
        }
      }

      const onAbort = () => {
        close()
      }
      request.signal.addEventListener("abort", onAbort, { once: true })

      try {
        if (payload.query.length > MAX_QUERY_CHARS) {
          send("error", {
            message: `Query is too long. Keep it under ${MAX_QUERY_CHARS} characters.`,
          })
          return
        }

        await streamAiAssistant({
          payload,
          emit: send,
          abortSignal: request.signal,
        })
      } catch (error: any) {
        logger.error("ai_search.stream.failed", {
          domain: "ai-search",
          route: "/api/ai-search/stream",
          sessionId: payload.sessionId,
          projectId: payload.currentProjectId,
          mode: payload.mode,
          queryLength: payload.query.length,
          error,
        })
        send("error", {
          message: error?.message ?? "Unable to stream AI response.",
        })
      } finally {
        request.signal.removeEventListener("abort", onAbort)
        close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

export async function GET() {
  return new Response(
    JSON.stringify({
      error: "AI search streaming requires POST so prompts are not sent in URLs.",
    }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST",
      },
    },
  )
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    q?: unknown
    query?: unknown
    limit?: unknown
    sessionId?: unknown
    mode?: unknown
    currentProjectId?: unknown
  }
  const query =
    (typeof body.q === "string" ? body.q : typeof body.query === "string" ? body.query : "").trim()

  return buildStreamResponse(request, {
    query,
    limit: parseLimit(body.limit),
    sessionId: parseSessionId(body.sessionId),
    mode: parseMode(body.mode),
    currentProjectId: parseProjectId(body.currentProjectId),
  })
}
