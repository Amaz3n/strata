import "server-only"

function appBaseUrl() {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (explicit?.trim()) return explicit.trim().replace(/\/$/, "")
  if (process.env.VERCEL_URL?.trim()) return `https://${process.env.VERCEL_URL.trim()}`.replace(/\/$/, "")
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000"
  return null
}
export async function triggerStartsPipeline() {
  const baseUrl = appBaseUrl()
  if (!baseUrl) return { triggered: false as const }
  try {
    const response = await fetch(`${baseUrl}/api/jobs/starts-pipeline`, {
      method: "POST",
      headers: process.env.CRON_SECRET ? { "x-cron-secret": process.env.CRON_SECRET } : undefined,
      signal: AbortSignal.timeout(5000),
    })
    return { triggered: response.ok, status: response.status }
  } catch {
    return { triggered: false as const }
  }
}
