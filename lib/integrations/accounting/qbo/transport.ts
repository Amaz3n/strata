import { accountingDeliveryDeadline, AccountingDeliveryError } from "@/lib/services/accounting-delivery"

const QBO_AUTH_TIMEOUT_MS = 10_000
const OAUTH_ERROR_CODES = new Set(["invalid_grant", "invalid_client", "invalid_request", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "access_denied", "temporarily_unavailable", "server_error"])

export class QBOTransportError extends AccountingDeliveryError {
  constructor(
    readonly operation: string,
    reason: string,
    readonly status: number | null = null,
    readonly intuitTid: string | null = null,
    readonly oauthCode: string | null = null,
    readonly started = false,
  ) {
    super(`QBO ${operation} failed (${reason}${status === null ? "" : `, HTTP ${status}`}${oauthCode ? `, ${oauthCode}` : ""})`, true, reason)
  }
}

export async function qboOAuthError(response: Response, operation: string): Promise<never> {
  const text = await response.text()
  let code: string | null = null
  try {
    const payload: unknown = JSON.parse(text)
    if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" && OAUTH_ERROR_CODES.has(payload.error)) code = payload.error
  } catch { /* Non-JSON provider bodies must never become credential/log text. */ }
  throw new QBOTransportError(operation, "provider", response.status, response.headers.get("intuit_tid") ?? response.headers.get("intuit-tid"), code, true)
}

/** Keep the abort scope alive through body consumption; ambiguous OAuth writes are never retried. */
export async function withQboResponse<T>(
  operation: string,
  url: string,
  init: RequestInit,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const now = Date.now()
  const inherited = accountingDeliveryDeadline() ?? Infinity
  const deadline = Math.min(now + QBO_AUTH_TIMEOUT_MS, inherited)
  if (deadline <= now) throw new QBOTransportError(operation, "deadline")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadline - now)
  let response: Response | undefined
  try {
    response = await fetch(url, { ...init, signal: controller.signal })
    const result = await consume(response)
    if (controller.signal.aborted) throw new Error("Aborted")
    return result
  } catch (error) {
    if (controller.signal.aborted) {
      throw new QBOTransportError(operation, inherited <= now + QBO_AUTH_TIMEOUT_MS ? "deadline" : "timeout", response?.status ?? null, response?.headers.get("intuit_tid") ?? response?.headers.get("intuit-tid") ?? null, null, true)
    }
    if (error instanceof QBOTransportError) throw error
    throw new QBOTransportError(operation, "transport", response?.status ?? null, response?.headers.get("intuit_tid") ?? response?.headers.get("intuit-tid") ?? null, null, true)
  } finally {
    clearTimeout(timer)
  }
}
