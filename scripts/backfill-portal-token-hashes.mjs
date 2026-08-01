#!/usr/bin/env node
// Backfills token_hash + token_encrypted for portal access tokens and invite
// tokens from their existing plaintext, using PORTAL_ACCESS_SECRET.
//
// Run once, after 20260801090000_portal_tokens_at_rest.sql and before the
// migration that drops the plaintext columns:
//
//   node --env-file=.env.local scripts/backfill-portal-token-hashes.mjs
//
// Idempotent — rows that already carry a hash are skipped, so a partial run can
// simply be repeated. Verify-only mode: pass --check.

import { createHash, createHmac, createCipheriv, hkdfSync, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const checkOnly = process.argv.includes("--check")

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

const secret = requireEnv("PORTAL_ACCESS_SECRET")
if (secret.length < 32) {
  throw new Error("PORTAL_ACCESS_SECRET must be at least 32 characters")
}

// Must stay byte-identical to lib/services/portal-credentials.ts.
function derivedKey(purpose) {
  return Buffer.from(hkdfSync("sha256", secret, "arc-portal-credentials", purpose, 32))
}

function hashToken(token) {
  return createHmac("sha256", derivedKey("lookup")).update(token).digest("hex")
}

function encryptToken(token) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", derivedKey("encryption"), iv)
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(".")
}

const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
})

async function backfillPortalTokens() {
  const { data, error } = await supabase
    .from("portal_access_tokens")
    .select("id, token, token_hash")
    .not("token", "is", null)

  if (error) throw new Error(`Failed to read portal tokens: ${error.message}`)

  const pending = (data ?? []).filter((row) => !row.token_hash)
  console.log(`portal_access_tokens: ${data?.length ?? 0} total, ${pending.length} need backfill`)
  if (checkOnly || pending.length === 0) return

  let done = 0
  for (const row of pending) {
    const { error: updateError } = await supabase
      .from("portal_access_tokens")
      .update({ token_hash: hashToken(row.token), token_encrypted: encryptToken(row.token) })
      .eq("id", row.id)
    if (updateError) throw new Error(`Failed to backfill token ${row.id}: ${updateError.message}`)
    done += 1
  }
  console.log(`portal_access_tokens: backfilled ${done}`)
}

async function backfillInviteTokens() {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, invite_token, invite_token_hash")
    .not("invite_token", "is", null)

  if (error) throw new Error(`Failed to read invite tokens: ${error.message}`)

  const pending = (data ?? []).filter((row) => !row.invite_token_hash)
  console.log(`memberships: ${data?.length ?? 0} with invites, ${pending.length} need backfill`)
  if (checkOnly || pending.length === 0) return

  let done = 0
  for (const row of pending) {
    // Invites are never re-displayed — the link only ever exists in the email —
    // so a lookup hash is all this one needs.
    const { error: updateError } = await supabase
      .from("memberships")
      .update({ invite_token_hash: createHash("sha256").update(row.invite_token).digest("hex") })
      .eq("id", row.id)
    if (updateError) throw new Error(`Failed to backfill invite ${row.id}: ${updateError.message}`)
    done += 1
  }
  console.log(`memberships: backfilled ${done}`)
}

async function main() {
  await backfillPortalTokens()
  await backfillInviteTokens()
  console.log(checkOnly ? "check complete" : "backfill complete")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
