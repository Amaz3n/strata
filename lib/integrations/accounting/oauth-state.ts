import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { z } from "zod"

const stateSchema = z
  .object({
    provider: z.string().regex(/^[a-z][a-z0-9_]*$/),
    orgId: z.string().uuid(),
    userId: z.string().uuid(),
    connectionId: z.string().uuid().nullable(),
    expectedAccountId: z.string().min(1).nullable(),
    nonce: z.string().min(20),
    expiresAt: z.number().int(),
  })
  .strict()
export type AccountingOAuthState = z.infer<typeof stateSchema>
function signature(payload: string) {
  const secret = process.env.TOKEN_ENCRYPTION_KEY
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is required")
  return createHmac("sha256", secret).update(`accounting-oauth:${payload}`).digest("base64url")
}
export function createAccountingOAuthState(
  input: Pick<AccountingOAuthState, "provider" | "orgId" | "userId"> &
    Partial<Pick<AccountingOAuthState, "connectionId" | "expectedAccountId">>,
) {
  const state = stateSchema.parse({
    ...input,
    connectionId: input.connectionId ?? null,
    expectedAccountId: input.expectedAccountId ?? null,
    nonce: randomBytes(24).toString("base64url"),
    expiresAt: Date.now() + 10 * 60 * 1000,
  })
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url")
  return `${payload}.${signature(payload)}`
}
export function verifyAccountingOAuthState(value: string, provider: string): AccountingOAuthState | null {
  const [payload, received, extra] = value.split(".")
  if (!payload || !received || extra) return null
  const expected = Buffer.from(signature(payload))
  const actual = Buffer.from(received)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    const parsed = stateSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    if (!parsed.success || parsed.data.provider !== provider || parsed.data.expiresAt <= Date.now()) return null
    return parsed.data
  } catch {
    return null
  }
}
export function accountingOAuthCookieName(state: Pick<AccountingOAuthState, "provider" | "nonce">) {
  return `accounting_oauth_${state.provider}_${state.nonce}`
}
