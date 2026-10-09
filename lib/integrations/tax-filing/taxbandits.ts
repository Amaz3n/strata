import "server-only"
import { createHmac } from "node:crypto"
import { z } from "zod"

/**
 * TaxBandits, the 1099 filing partner. OAuth 2.0: a JWS signed with the client
 * secret is exchanged for an hour-long access token. The sandbox never reaches
 * the IRS; it decides outcomes by the payer's TIN.
 */
const API_VERSION = "v1.7.3"

function environment() {
  const value = process.env.TAXBANDITS_ENV ?? "sandbox"
  if (value !== "sandbox" && value !== "production") throw new Error("TAXBANDITS_ENV must be sandbox or production")
  return value === "sandbox"
    ? { auth: "https://testoauth.expressauth.net/v2/tbsauth", api: `https://testapi.taxbandits.com/${API_VERSION}` }
    : { auth: "https://oauth.expressauth.net/v2/tbsauth", api: `https://api.taxbandits.com/${API_VERSION}` }
}

function requireEnv(name: "TAXBANDITS_CLIENT_ID" | "TAXBANDITS_CLIENT_SECRET" | "TAXBANDITS_USER_TOKEN") {
  const value = process.env[name]
  if (!value) throw new Error(`Missing environment variable: ${name}`)
  return value
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url")

let cached: { token: string; expiresAt: number } | null = null

async function accessToken() {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  const clientId = requireEnv("TAXBANDITS_CLIENT_ID")
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = base64url(JSON.stringify({ iss: clientId, sub: clientId, aud: requireEnv("TAXBANDITS_USER_TOKEN"), iat: Math.floor(Date.now() / 1000) }))
  const signature = base64url(createHmac("sha256", requireEnv("TAXBANDITS_CLIENT_SECRET")).update(`${header}.${payload}`).digest())
  const response = await fetch(environment().auth, { method: "GET", headers: { Authentication: `${header}.${payload}.${signature}` }, cache: "no-store" })
  const body = z.object({ AccessToken: z.string().nullish(), ExpiresIn: z.number().nullish(), StatusMessage: z.string().nullish() }).passthrough().parse(await response.json())
  if (!response.ok || !body.AccessToken) throw new Error(`TaxBandits sign-in failed: ${body.StatusMessage ?? `HTTP ${response.status}`}`)
  cached = { token: body.AccessToken, expiresAt: Date.now() + (body.ExpiresIn ?? 3600) * 1000 }
  return cached.token
}

async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
  const response = await fetch(`${environment().api}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  })
  const payload: unknown = await response.json().catch(() => null)
  return { status: response.status, payload }
}

const errorSchema = z.object({ Id: z.string().nullish(), Name: z.string().nullish(), Message: z.string().nullish() }).passthrough()
const recordSchema = z.object({
  SequenceId: z.string().nullish(),
  RecordId: z.string().nullish(),
  FederalReturn: z.object({ Status: z.string().nullish(), Errors: z.array(errorSchema).nullish() }).passthrough().nullish(),
  Status: z.string().nullish(),
  Errors: z.array(errorSchema).nullish(),
}).passthrough()
const submissionSchema = z.object({
  SubmissionId: z.string().nullish(),
  Form1099Records: z.object({ SuccessRecords: z.array(recordSchema).nullish(), ErrorRecords: z.array(recordSchema).nullish() }).passthrough().nullish(),
  Errors: z.array(errorSchema).nullish(),
}).passthrough()
export type TaxBanditsSubmission = z.infer<typeof submissionSchema>

/** Creates the returns of one payer; nothing reaches the IRS until transmitted. */
export async function createTaxBanditsNecSubmission(request: Record<string, unknown>) {
  return submissionSchema.parse((await call("POST", "Form1099NEC/Create", request)).payload)
}

/** Removes every return of a submission that was not transmitted. */
export async function deleteTaxBanditsSubmission(submissionId: string) {
  return submissionSchema.parse((await call("DELETE", `Form1099NEC/Delete?SubmissionId=${encodeURIComponent(submissionId)}`)).payload)
}

export async function transmitTaxBanditsSubmission(submissionId: string) {
  return submissionSchema.parse((await call("POST", "Form1099NEC/Transmit", { SubmissionId: submissionId })).payload)
}

/** Each record's federal status and the reasons it gives, whichever record layout the response uses. */
export async function getTaxBanditsSubmissionStatus(submissionId: string) {
  const payload = z.object({ Form1099Records: z.unknown().nullish() }).passthrough().parse((await call("GET", `Form1099NEC/Status?SubmissionId=${encodeURIComponent(submissionId)}`)).payload)
  const listed = z.array(recordSchema).safeParse(payload.Form1099Records)
  const grouped = z.object({ SuccessRecords: z.array(recordSchema).nullish(), ErrorRecords: z.array(recordSchema).nullish() }).safeParse(payload.Form1099Records)
  const records = listed.success ? listed.data : grouped.success ? [...(grouped.data.SuccessRecords ?? []), ...(grouped.data.ErrorRecords ?? [])] : []
  return records.map((record) => ({
    recordId: record.RecordId ?? null,
    status: record.FederalReturn?.Status ?? record.Status ?? null,
    errors: [...(record.FederalReturn?.Errors ?? []), ...(record.Errors ?? [])].map((error) => error.Message ?? error.Name ?? "Rejected"),
  }))
}
