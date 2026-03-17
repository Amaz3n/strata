import { NextRequest } from "next/server"

import { askAiSearch, type AiSearchTraceEvent } from "@/lib/services/ai-search"

export const runtime = "nodejs"
const MAX_QUERY_CHARS = 1_200

type StreamPayload = {
  query: string
  limit?: number
  sessionId?: string
  mode?: "org" | "general"
}

function toSseEvent(event: string, data: unknown) {
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
        send("trace", {
          id: "stream-open",
          status: "started",
          label: "Session started",
          detail: "Secure stream is active and waiting for your org query plan.",
          thought: "Opening a secure stream and preparing to plan your request.",
          timestamp: new Date().toISOString(),
        } satisfies AiSearchTraceEvent)

        if (payload.query.length > MAX_QUERY_CHARS) {
          send("error", {
            message: `Query is too long. Keep it under ${MAX_QUERY_CHARS} characters.`,
          })
          return
        }

        const response = await askAiSearch(payload.query, {
          limit: payload.limit,
          sessionId: payload.sessionId,
          mode: payload.mode,
          onTrace: (event) => {
            send("trace", event)
          },
        })

        send("result", response)
      } catch (error: any) {
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

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get("q")?.trim() ?? ""
  return buildStreamResponse(request, {
    query,
    limit: parseLimit(request.nextUrl.searchParams.get("limit")),
    sessionId: parseSessionId(request.nextUrl.searchParams.get("sessionId")),
    mode: parseMode(request.nextUrl.searchParams.get("mode")),
  })
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    q?: unknown
    query?: unknown
    limit?: unknown
    sessionId?: unknown
    mode?: unknown
  }
  const query =
    (typeof body.q === "string" ? body.q : typeof body.query === "string" ? body.query : "").trim()

  return buildStreamResponse(request, {
    query,
    limit: parseLimit(body.limit),
    sessionId: parseSessionId(body.sessionId),
    mode: parseMode(body.mode),
  })
}
