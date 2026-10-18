import "server-only"
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

type AccessRequest = { id: string; org_id: string; token_hash: string; access_code_hash?: string | null }
export function hashSigningAccessCode(code: string) {
  if (typeof code !== "string" || code.length < 6 || code.length > 128) throw new Error("Access codes must contain 6–128 characters")
  const salt = randomBytes(16).toString("hex")
  return `${salt}:${scryptSync(code, salt, 32).toString("hex")}`
}
function accessProof(request: AccessRequest, expiry: number) {
  const secret = process.env.DOCUMENT_SIGNING_SECRET
  if (!secret) throw new Error("Missing document signing secret")
  return createHmac("sha256", secret).update(`esign-access:${request.id}:${request.token_hash}:${request.access_code_hash}:${expiry}`).digest("hex")
}
export async function hasSigningAccess(request: AccessRequest) {
  if (!request.access_code_hash) return true
  const value = (await cookies()).get(`esign-access-${request.id}`)?.value ?? ""
  const [expiryText, proof] = value.split(".")
  const expiry = Number(expiryText)
  if (!Number.isSafeInteger(expiry) || expiry < Date.now() || !proof) return false
  const expected = accessProof(request, expiry)
  return proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected))
}
export async function requireSigningAccess(request: AccessRequest) {
  if (!(await hasSigningAccess(request))) throw new Error("Enter the sender's access code before opening this document")
}
export async function unlockSigningAccess(request: AccessRequest, code: string) {
  if (!request.access_code_hash) return
  if (typeof code !== "string" || code.length > 128) throw new Error("Invalid access code")
  const { error } = await createServiceSupabaseClient().rpc("claim_esign_access_attempt", { p_org_id: request.org_id, p_request_id: request.id })
  if (error) throw new Error("Too many attempts. Please wait 15 minutes and try again.")
  const [salt, hash] = request.access_code_hash.split(":")
  const actual = scryptSync(code, salt, 32)
  if (!hash || hash.length !== 64 || !timingSafeEqual(actual, Buffer.from(hash, "hex"))) throw new Error("The access code is incorrect")
  const expiry = Date.now() + 60 * 60 * 1000
  ;(await cookies()).set(`esign-access-${request.id}`, `${expiry}.${accessProof(request, expiry)}`, { httpOnly:true, secure:process.env.NODE_ENV === "production", sameSite:"lax", path:"/", maxAge:3600 })
}
