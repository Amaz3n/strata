import "server-only"

/**
 * Fire-and-forget kick for the in-app drawings pipeline. The kick route
 * responds immediately and drains the queue after the response, so callers
 * only wait for the connection handshake. If this fails, the process-outbox
 * cron picks the jobs up — nothing is ever lost, only delayed.
 */

interface TriggerResult {
  triggered: boolean
  status?: number
  error?: string
}

function resolveAppBaseUrl(): string | null {
  // Dev first: NEXT_PUBLIC_APP_URL often points at a tunnel (ngrok) that may
  // be dead, and a failed kick silently strands local pipeline work on the
  // production cron. The local server is the one running this code — kick it.
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000"
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (explicit?.trim()) return explicit.trim().replace(/\/$/, "")
  if (process.env.VERCEL_URL?.trim()) return `https://${process.env.VERCEL_URL.trim()}`.replace(/\/$/, "")
  return null
}

export async function triggerDrawingsPipeline(): Promise<TriggerResult> {
  const baseUrl = resolveAppBaseUrl()
  if (!baseUrl) {
    return { triggered: false, error: "Unable to resolve app base URL for pipeline trigger" }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const response = await fetch(`${baseUrl}/api/jobs/drawings-pipeline`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.CRON_SECRET ? { "x-cron-secret": process.env.CRON_SECRET } : {}),
      },
      body: JSON.stringify({ trigger: "app" }),
      signal: controller.signal,
    })

    if (!response.ok) {
      return { triggered: false, status: response.status, error: `HTTP ${response.status}` }
    }
    return { triggered: true, status: response.status }
  } catch (error) {
    return {
      triggered: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}
