import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto"
import { z } from "zod"

import type {
  BankFeedAccount,
  BankFeedProvider,
  BankFeedTransaction,
  TransactionSyncPage,
} from "@/lib/integrations/banking/provider"

const linkTokenSchema = z.object({ link_token: z.string(), expiration: z.string() })
const exchangeSchema = z.object({ access_token: z.string(), item_id: z.string() })
const accountSchema = z.object({
  account_id: z.string(),
  name: z.string(),
  official_name: z.string().nullable().optional(),
  mask: z.string().nullable().optional(),
  type: z.string(),
  subtype: z.string().nullable().optional(),
  balances: z.object({
    current: z.number().nullable().optional(),
    available: z.number().nullable().optional(),
    iso_currency_code: z.string().nullable().optional(),
  }),
})
const transactionSchema = z.object({
  transaction_id: z.string(),
  account_id: z.string(),
  pending: z.boolean(),
  date: z.string(),
  authorized_date: z.string().nullable().optional(),
  amount: z.number(),
  iso_currency_code: z.string().nullable().optional(),
  merchant_name: z.string().nullable().optional(),
  name: z.string(),
  pending_transaction_id: z.string().nullable().optional(),
  personal_finance_category: z.object({ primary: z.string(), detailed: z.string() }).nullable().optional(),
}).passthrough()
const syncSchema = z.object({
  added: z.array(transactionSchema),
  modified: z.array(transactionSchema),
  removed: z.array(z.object({ transaction_id: z.string() })),
  next_cursor: z.string(),
  has_more: z.boolean(),
})
const verificationKeySchema = z.object({
  key: z.object({
    alg: z.literal("ES256"),
    crv: z.literal("P-256"),
    kid: z.string(),
    kty: z.literal("EC"),
    use: z.string(),
    x: z.string(),
    y: z.string(),
    expired_at: z.number().nullable().optional(),
  }),
})
const jwtPayloadSchema = z.object({ iat: z.number(), request_body_sha256: z.string() })

function requireEnv(name: "PLAID_CLIENT_ID" | "PLAID_SECRET") {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

function plaidBaseUrl() {
  const environment = process.env.PLAID_ENV ?? "sandbox"
  if (!new Set(["sandbox", "production"]).has(environment)) throw new Error("PLAID_ENV must be sandbox or production")
  return `https://${environment}.plaid.com`
}

async function request(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${plaidBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": requireEnv("PLAID_CLIENT_ID"),
      "PLAID-SECRET": requireEnv("PLAID_SECRET"),
      "Plaid-Version": "2020-09-14",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error_message" in payload
      ? String(payload.error_message)
      : `HTTP ${response.status}`
    throw new Error(`Plaid ${path} failed: ${message}`)
  }
  return payload
}

function dollarsToAbsoluteCents(value: number) {
  return Math.round(Math.abs(value) * 100)
}

function normalizeAccountType(value: string): BankFeedAccount["type"] {
  if (value === "depository" || value === "credit" || value === "loan" || value === "investment") return value
  return "other"
}

function normalizeTransaction(value: z.infer<typeof transactionSchema>): BankFeedTransaction {
  return {
    externalTransactionId: value.transaction_id,
    externalAccountId: value.account_id,
    lifecycleStatus: value.pending ? "pending" : "posted",
    transactionDate: value.date,
    authorizedDate: value.authorized_date ?? null,
    amountCents: dollarsToAbsoluteCents(value.amount),
    direction: value.amount < 0 ? "inflow" : "outflow",
    currency: (value.iso_currency_code ?? "USD").toLowerCase(),
    merchantName: value.merchant_name ?? null,
    description: value.name,
    pendingExternalId: value.pending_transaction_id ?? null,
    category: value.personal_finance_category
      ? [value.personal_finance_category.primary, value.personal_finance_category.detailed]
      : [],
    raw: value,
  }
}

function decodeJwtPart(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown
}

function equalText(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export const plaidBankFeedProvider: BankFeedProvider = {
  key: "plaid",

  async createLinkToken(input) {
    const payload = linkTokenSchema.parse(await request("/link/token/create", {
      user: { client_user_id: input.clientUserId },
      client_name: input.organizationName,
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      webhook: input.webhookUrl,
      transactions: { days_requested: 730 },
    }))
    return { linkToken: payload.link_token, expiresAt: payload.expiration }
  },

  async exchangePublicToken(publicToken) {
    const payload = exchangeSchema.parse(await request("/item/public_token/exchange", { public_token: publicToken }))
    return { accessToken: payload.access_token, itemId: payload.item_id }
  },

  async listAccounts(accessToken) {
    const payload = z.object({ accounts: z.array(accountSchema) }).parse(await request("/accounts/get", { access_token: accessToken }))
    return payload.accounts.map<BankFeedAccount>((account) => ({
      externalAccountId: account.account_id,
      name: account.name,
      officialName: account.official_name ?? null,
      mask: account.mask ?? null,
      type: normalizeAccountType(account.type),
      subtype: account.subtype ?? null,
      currency: (account.balances.iso_currency_code ?? "USD").toLowerCase(),
      currentBalanceCents: account.balances.current == null ? null : Math.round(account.balances.current * 100),
      availableBalanceCents: account.balances.available == null ? null : Math.round(account.balances.available * 100),
    }))
  },

  async syncTransactions(accessToken, cursor): Promise<TransactionSyncPage> {
    const payload = syncSchema.parse(await request("/transactions/sync", {
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
      count: 500,
      options: { include_personal_finance_category: true },
    }))
    return {
      added: payload.added.map(normalizeTransaction),
      modified: payload.modified.map(normalizeTransaction),
      removedExternalIds: payload.removed.map((item) => item.transaction_id),
      nextCursor: payload.next_cursor,
      hasMore: payload.has_more,
    }
  },

  async verifyWebhook(rawBody, verificationHeader) {
    if (!verificationHeader) return false
    const parts = verificationHeader.split(".")
    if (parts.length !== 3) return false
    const header = z.object({ alg: z.literal("ES256"), kid: z.string() }).safeParse(decodeJwtPart(parts[0]))
    if (!header.success) return false
    const response = verificationKeySchema.parse(await request("/webhook_verification_key/get", { key_id: header.data.kid }))
    if (response.key.expired_at && response.key.expired_at <= Math.floor(Date.now() / 1000)) return false
    const key = createPublicKey({ key: response.key, format: "jwk" })
    const signatureValid = verify(
      "sha256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(parts[2], "base64url"),
    )
    if (!signatureValid) return false
    const payload = jwtPayloadSchema.safeParse(decodeJwtPart(parts[1]))
    if (!payload.success || Math.abs(Date.now() / 1000 - payload.data.iat) > 5 * 60) return false
    const digest = createHash("sha256").update(rawBody).digest("hex")
    return equalText(digest, payload.data.request_body_sha256)
  },
}
