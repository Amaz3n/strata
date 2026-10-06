import { BankFeedProviderError } from "@/lib/integrations/banking/provider"

export type BankFeedConnectionStatus = "active" | "reauth_required" | "error" | "disconnected"

const REAUTH_ERROR_CODES = new Set([
  "ACCESS_NOT_GRANTED",
  "INVALID_CREDENTIALS",
  "ITEM_LOCKED",
  "ITEM_LOGIN_REQUIRED",
  "PASSWORD_RESET_REQUIRED",
  "USER_SETUP_REQUIRED",
])

export function bankFeedFailureState(error: unknown): {
  status: Extract<BankFeedConnectionStatus, "reauth_required" | "error">
  lastError: string
} {
  const message = error instanceof Error ? error.message : String(error)
  const needsReauthentication =
    error instanceof BankFeedProviderError &&
    error.errorType === "ITEM_ERROR" &&
    Boolean(error.errorCode && REAUTH_ERROR_CODES.has(error.errorCode))
  return {
    status: needsReauthentication ? "reauth_required" : "error",
    lastError: message.slice(0, 1000),
  }
}

export function bankFeedWebhookFailureState(payload: unknown) {
  const error = payload && typeof payload === "object" && "error" in payload && payload.error && typeof payload.error === "object"
    ? payload.error
    : null
  const errorType = error && "error_type" in error ? String(error.error_type) : null
  const errorCode = error && "error_code" in error ? String(error.error_code) : null
  const message = error && "error_message" in error ? String(error.error_message) : "Plaid reported a connection error"
  return bankFeedFailureState(new BankFeedProviderError(message, errorType, errorCode))
}

export function canSyncBankFeed(status: string) {
  return status === "active" || status === "reauth_required" || status === "error"
}

export function bankFeedSuccessState() {
  return { status: "active" as const, lastError: null }
}
