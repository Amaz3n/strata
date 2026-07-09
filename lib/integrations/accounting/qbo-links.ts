/**
 * QuickBooks Online web-app deep links. Safe to import from client components:
 * environment is derived from the build (dev builds link to the sandbox company
 * UI, production builds to the live one), mirroring the server-side default in
 * qbo-config.ts.
 */
const QBO_APP_BASE_URL =
  process.env.NODE_ENV !== "production" ? "https://app.sandbox.qbo.intuit.com" : "https://qbo.intuit.com"

export type QboTxnPage = "bill" | "expense" | "vendorcredit" | "invoice"

export function qboTxnUrl(page: QboTxnPage, qboId: string | null | undefined): string | null {
  if (!qboId) return null
  return `${QBO_APP_BASE_URL}/app/${page}?txnId=${encodeURIComponent(qboId)}`
}

export function qboHomepageUrl() {
  return `${QBO_APP_BASE_URL}/app/homepage`
}
