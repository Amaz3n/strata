import { createHmac, timingSafeEqual } from "node:crypto"
import type { SupabaseClient, PostgrestError } from "@supabase/supabase-js"

function signingSecret() {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) throw new Error("Missing document signing secret")
  return secret
}

export function hashSigningToken(token: string) {
  return createHmac("sha256", signingSecret()).update(token).digest("hex")
}

/** A recoverable alias for the existing invitation, revoked by rotating its hash. */
export function createRecoverableSigningToken(request: { id: string; token_hash: string }) {
  if (!request.token_hash) throw new Error("Signing request has no invitation token")
  const signature = createHmac("sha256", signingSecret())
    .update(`arc-signing-link:v1:${request.id}:${request.token_hash}`).digest("hex")
  return `v1.${request.id}.${signature}`
}

export async function resolveSigningRequestToken(supabase: SupabaseClient, token: string, select = "*"): Promise<{ data: any; error: PostgrestError | null }> {
  if (!token.startsWith("v1.")) {
    return supabase.from("document_signing_requests").select(select).eq("token_hash", hashSigningToken(token)).maybeSingle()
  }
  const parts = token.split(".")
  if (parts.length !== 3 || !/^[0-9a-f-]{36}$/i.test(parts[1]) || !/^[0-9a-f]{64}$/i.test(parts[2])) {
    return { data: null, error: null }
  }
  const result = await supabase.from("document_signing_requests").select(`${select},id,token_hash`).eq("id", parts[1]).maybeSingle()
  const request = result.data as unknown as { id: string; token_hash: string } | null
  if (result.error || !request?.token_hash) return { data: null, error: result.error }
  const expected = createRecoverableSigningToken(request)
  if (expected.length !== token.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(token))) {
    return { data: null, error: null }
  }
  return result
}
