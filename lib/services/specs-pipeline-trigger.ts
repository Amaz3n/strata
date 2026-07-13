import "server-only"

function appBaseUrl() {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (explicit?.trim()) return explicit.trim().replace(/\/$/, "")
  if (process.env.VERCEL_URL?.trim()) return `https://${process.env.VERCEL_URL.trim()}`
  return process.env.NODE_ENV !== "production" ? "http://localhost:3000" : null
}

export async function triggerSpecsPipeline() {
  const baseUrl = appBaseUrl()
  if (!baseUrl) return { triggered: false as const }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${baseUrl}/api/jobs/specs-pipeline`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.CRON_SECRET ? { "x-cron-secret": process.env.CRON_SECRET } : {}) },
      body: JSON.stringify({ trigger: "app" }), signal: controller.signal,
    })
    return { triggered: response.ok, status: response.status }
  } catch {
    return { triggered: false as const }
  } finally {
    clearTimeout(timeout)
  }
}
