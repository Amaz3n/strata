#!/usr/bin/env node
// READ-ONLY diagnostic: reproduce the QBO Change Data Capture (CDC) call for one
// org using the ALREADY-STORED access token. Makes NO Intuit token refresh (no
// rotation) and NO DB writes. Pure GET against the prod CDC endpoint.
//
//   node --env-file=.env.local scripts/qbo-cdc-probe.mjs <orgId>

import { createDecipheriv } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const PROD_API_BASE = "https://quickbooks.api.intuit.com/v3/company"
const ENTITIES = ["Invoice", "Payment", "Purchase", "Bill", "BillPayment"]

const orgId = process.argv.slice(2).find((a) => !a.startsWith("--"))
if (!orgId) {
  console.error("Missing <orgId>")
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
const ENC_KEY_RAW = process.env.TOKEN_ENCRYPTION_KEY

function getEncryptionKey() {
  const raw = ENC_KEY_RAW
  if (raw.length === 32) return Buffer.from(raw)
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) return Buffer.from(raw, "hex")
  const buf = Buffer.from(raw, "base64")
  if (buf.length === 32) return buf
  throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes")
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

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const { data: row, error } = await supabase
  .from("qbo_connections")
  .select("id, realm_id, status, access_token, token_expires_at")
  .eq("org_id", orgId)
  .eq("status", "active")
  .single()

if (error || !row) {
  console.error("No active connection:", error?.message)
  process.exit(1)
}

console.log("realm:", row.realm_id, "| token_expires_at:", row.token_expires_at)
const token = decryptToken(row.access_token)

const changedSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
const params = new URLSearchParams({ entities: ENTITIES.join(","), changedSince })
const url = `${PROD_API_BASE}/${row.realm_id}/cdc?${params.toString()}`

console.log("GET", url, "\n")
const resp = await fetch(url, {
  headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
})
const body = await resp.text()
console.log("status:", resp.status)
console.log("intuit_tid:", resp.headers.get("intuit_tid"))
if (resp.status === 200) {
  const json = JSON.parse(body)
  const qr = json.CDCResponse?.[0]?.QueryResponse ?? []
  for (const block of qr) {
    for (const k of Object.keys(block)) {
      if (Array.isArray(block[k])) {
        console.log(`  ${k}:`, block[k].map((e) => `${e.Id}(tok ${e.SyncToken}, upd ${e.MetaData?.LastUpdatedTime})`).join(", "))
      }
    }
  }
} else {
  console.log("body:", body.slice(0, 2000))
}
