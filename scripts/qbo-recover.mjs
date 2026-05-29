#!/usr/bin/env node
// One-off QBO connection recovery.
//
// Context: a QBO connection can be marked `expired` in our DB by a refresh
// attempt made with the WRONG QuickBooks app credentials (e.g. a local dev box
// pointed at the prod Supabase DB, carrying development QBO keys). That refresh
// is rejected by Intuit (`invalid_grant` / "Incorrect Token type or clientID")
// WITHOUT consuming/revoking the token. This script refreshes the stored token
// with the CORRECT (production) credentials and, on success, restores the row.
//
// IMPORTANT: a successful refresh ROTATES the token (Intuit invalidates the old
// refresh token and issues a new one). So there is no "test without saving":
//   - default              -> preview only, NO Intuit call
//   - --commit             -> refresh at Intuit AND persist the new tokens
//
// Usage (run locally, but supply PRODUCTION QBO keys inline so the refresh is
// authenticated by the app that owns the token; SUPABASE_* and
// TOKEN_ENCRYPTION_KEY come from .env.local, which already targets prod):
//
//   PROD_QBO_CLIENT_ID='<prod id>' PROD_QBO_CLIENT_SECRET='<prod secret>' \
//     node --env-file=.env.local scripts/qbo-recover.mjs <connectionId>
//
//   # when the preview looks right:
//   PROD_QBO_CLIENT_ID='<prod id>' PROD_QBO_CLIENT_SECRET='<prod secret>' \
//     node --env-file=.env.local scripts/qbo-recover.mjs <connectionId> --commit

import { createDecipheriv, createCipheriv, randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"

const args = process.argv.slice(2)
const commit = args.includes("--commit")
const connectionId = args.find((a) => !a.startsWith("--"))

function fail(msg) {
  console.error(`\n✖ ${msg}\n`)
  process.exit(1)
}

if (!connectionId) {
  fail("Missing <connectionId>. Pass the qbo_connections.id to recover.")
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ENC_KEY_RAW = process.env.TOKEN_ENCRYPTION_KEY
const CLIENT_ID = process.env.PROD_QBO_CLIENT_ID
const CLIENT_SECRET = process.env.PROD_QBO_CLIENT_SECRET

if (!SUPABASE_URL || !SERVICE_ROLE) fail("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (load .env.local with --env-file).")
if (!ENC_KEY_RAW) fail("Missing TOKEN_ENCRYPTION_KEY (must match the key the token was encrypted with).")
// Prod QBO keys are only needed for the actual refresh (--commit); preview is read-only.
if (commit && (!CLIENT_ID || !CLIENT_SECRET)) fail("Missing PROD_QBO_CLIENT_ID / PROD_QBO_CLIENT_SECRET (supply the PRODUCTION QBO app keys inline for --commit).")

// --- crypto: mirrors lib/integrations/accounting/qbo-auth.ts exactly ---
function getEncryptionKey() {
  const raw = ENC_KEY_RAW
  if (raw.length === 32) return Buffer.from(raw)
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) return Buffer.from(raw, "hex")
  try {
    const buf = Buffer.from(raw, "base64")
    if (buf.length === 32) return buf
  } catch {
    // fall through
  }
  fail("TOKEN_ENCRYPTION_KEY must be 32 bytes (raw, hex, or base64)")
}

function decryptToken(encrypted) {
  const key = getEncryptionKey()
  const buffer = Buffer.from(encrypted, "base64")
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const payload = buffer.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8")
}

function encryptToken(token) {
  const key = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString("base64")
}

function fingerprint(s) {
  if (!s) return "(none)"
  return `len=${s.length} tail=…${s.slice(-4)}`
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { data: row, error } = await supabase
  .from("qbo_connections")
  .select("id, org_id, realm_id, company_name, status, refresh_failure_count, last_error, token_expires_at, refresh_token_expires_at, refresh_token, access_token")
  .eq("id", connectionId)
  .maybeSingle()

if (error) fail(`DB read failed: ${error.message}`)
if (!row) fail(`No qbo_connections row with id=${connectionId}`)

console.log("\n── Current connection ──────────────────────────────────────")
console.log(`  id:                       ${row.id}`)
console.log(`  org_id:                   ${row.org_id}`)
console.log(`  company:                  ${row.company_name ?? "(null)"}`)
console.log(`  realm_id:                 ${row.realm_id}`)
console.log(`  status:                   ${row.status}`)
console.log(`  refresh_failure_count:    ${row.refresh_failure_count}`)
console.log(`  token_expires_at:         ${row.token_expires_at}`)
console.log(`  refresh_token_expires_at: ${row.refresh_token_expires_at}`)
console.log(`  last_error:               ${row.last_error ?? "(null)"}`)

// Verify the encryption key can actually read the stored token before anything else.
let refreshToken
try {
  refreshToken = decryptToken(row.refresh_token)
  console.log(`  refresh_token (decrypted): ${fingerprint(refreshToken)}  ✓ decrypt ok`)
} catch (e) {
  fail(`Could not decrypt the stored refresh_token — TOKEN_ENCRYPTION_KEY does not match the one used to encrypt it. (${e?.message ?? e})`)
}

if (!commit) {
  console.log("\n── Preview only ────────────────────────────────────────────")
  console.log("  No Intuit call was made. A successful refresh ROTATES the token,")
  console.log("  so this only happens with --commit (which then persists the result).")
  console.log("\n  To recover, re-run with --commit using the PRODUCTION QBO keys:")
  console.log(`    PROD_QBO_CLIENT_ID='…' PROD_QBO_CLIENT_SECRET='…' \\`)
  console.log(`      node --env-file=.env.local scripts/qbo-recover.mjs ${connectionId} --commit\n`)
  process.exit(0)
}

console.log("\n── Refreshing at Intuit (PRODUCTION creds) ─────────────────")
const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")
const resp = await fetch(INTUIT_TOKEN_URL, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: `Basic ${credentials}`,
  },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
})

if (!resp.ok) {
  const body = await resp.text().catch(() => "(no body)")
  console.error(`\n✖ Intuit refresh FAILED (${resp.status}): ${body}`)
  console.error("\n  Verdict: this token cannot be refreshed with these credentials.")
  console.error("  • If error is invalid_grant → the token is genuinely revoked/expired → the client must reconnect.")
  console.error("  • If error mentions client/invalid_client → the PROD_QBO_* keys are wrong, not the token.")
  console.error("  Nothing was written to the database.\n")
  process.exit(2)
}

const tokens = await resp.json()
const newExpiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString()
const newRefreshExpiresAt =
  tokens.x_refresh_token_expires_in && tokens.x_refresh_token_expires_in > 0
    ? new Date(Date.now() + tokens.x_refresh_token_expires_in * 1000).toISOString()
    : row.refresh_token_expires_at

console.log("  ✓ Intuit accepted the refresh — token is ALIVE and now rotated.")
console.log(`    new refresh_token:        ${fingerprint(tokens.refresh_token)}`)
console.log(`    new token_expires_at:     ${newExpiresAt}`)
console.log(`    new refresh_token_expires:${newRefreshExpiresAt}`)

// Persist immediately — the old refresh token is now invalid, so we MUST save.
// Optimistic guard on the refresh_token we read, so we never clobber a row that
// changed underneath us between read and write.
const baseUpdate = {
  access_token: encryptToken(tokens.access_token),
  refresh_token: encryptToken(tokens.refresh_token),
  token_expires_at: newExpiresAt,
  refresh_token_expires_at: newRefreshExpiresAt,
  refresh_failure_count: 0,
  status: "active",
  last_error: null,
}

async function persist(payload) {
  return supabase
    .from("qbo_connections")
    .update(payload)
    .eq("id", row.id)
    .eq("refresh_token", row.refresh_token)
    .select("id, status")
    .maybeSingle()
}

// Stamp the owning app (client_id) so a mismatched environment can't expire it
// again. If the client_id column isn't there yet (migration not pushed), fall
// back to saving the tokens without it — recovery must not be blocked by that.
let { data: updated, error: updErr } = await persist({ ...baseUpdate, client_id: CLIENT_ID })
if (updErr && /client_id/i.test(updErr.message)) {
  console.warn("  (client_id column not present yet — saving tokens without it; push the migration to enable the guard.)")
  ;({ data: updated, error: updErr } = await persist(baseUpdate))
}

if (updErr) {
  fail(`Intuit refresh SUCCEEDED but DB write failed: ${updErr.message}. The new refresh token was NOT saved — the connection now needs a manual reconnect.`)
}

if (!updated) {
  fail("Intuit refresh SUCCEEDED but the row changed between read and write (optimistic guard). The new refresh token was NOT saved — reconnect required.")
}

console.log("\n✔ RECOVERED — qbo_connections row is active again with a fresh token.")
console.log("  The client does not need to reconnect.\n")
console.log("  ⚠ Make sure no local-dev process (with dev QBO keys) touches this org,")
console.log("    or it will expire the row again. Fix the root cause: don't point local")
console.log("    dev at the prod Supabase DB, and/or add the client_id refresh guard.\n")
