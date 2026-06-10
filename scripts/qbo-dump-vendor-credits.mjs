#!/usr/bin/env node
// READ-ONLY: dump raw QBO JSON for VendorCredit + BillPayment (+ a named Bill) so we
// can see the exact shape of an *applied* vendor credit before implementing import.
// Uses the already-stored access token. NO token refresh, NO DB writes, NO QBO writes.
//
//   node --env-file=.env.local scripts/qbo-dump-vendor-credits.mjs [orgId] [billDocNumber]
//
// orgId is optional: if omitted and exactly one active qbo_connection exists, it's used.
// billDocNumber defaults to ARC-BILL-1.

import { createDecipheriv } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const SANDBOX_API_BASE = "https://sandbox-quickbooks.api.intuit.com/v3/company"
const PROD_API_BASE = "https://quickbooks.api.intuit.com/v3/company"

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"))
const argOrgId = args[0] ?? null
const billDoc = args[1] ?? "ARC-BILL-1"

// local/dev defaults to sandbox, matching lib/integrations/accounting/qbo-config.ts
const sandboxEnv = (process.env.QBO_SANDBOX ?? "").trim().toLowerCase()
const isSandbox = ["1", "true", "yes", "on"].includes(sandboxEnv)
  ? true
  : ["0", "false", "no", "off"].includes(sandboxEnv)
    ? false
    : process.env.NODE_ENV !== "production"
const API_BASE = isSandbox ? SANDBOX_API_BASE : PROD_API_BASE

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

// Auto-detect the active connection when no orgId is passed.
let connQuery = supabase
  .from("qbo_connections")
  .select("id, org_id, realm_id, status, access_token, token_expires_at")
  .eq("status", "active")
if (argOrgId) connQuery = connQuery.eq("org_id", argOrgId)

const { data: rows, error } = await connQuery
if (error) {
  console.error("Query failed:", error.message)
  process.exit(1)
}
if (!rows || rows.length === 0) {
  console.error("No active qbo_connection found", argOrgId ? `for org ${argOrgId}` : "")
  process.exit(1)
}
if (rows.length > 1) {
  console.error("Multiple active connections — pass an orgId. Candidates:")
  for (const r of rows) console.error(`  org_id=${r.org_id} realm=${r.realm_id}`)
  process.exit(1)
}

const row = rows[0]
console.log(`env: ${isSandbox ? "sandbox" : "production"} | org: ${row.org_id} | realm: ${row.realm_id}\n`)
const token = decryptToken(row.access_token)

async function q(query) {
  const url = `${API_BASE}/${row.realm_id}/query?query=${encodeURIComponent(query)}&minorversion=73`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
  const body = await resp.text()
  if (resp.status !== 200) {
    console.error(`  ! ${resp.status} for [${query}] tid=${resp.headers.get("intuit_tid")}`)
    console.error("   ", body.slice(0, 800))
    return {}
  }
  return JSON.parse(body).QueryResponse ?? {}
}

function dump(label, arr) {
  console.log(`\n================ ${label} (${arr?.length ?? 0}) ================`)
  for (const obj of arr ?? []) console.log(JSON.stringify(obj, null, 2))
}

const vc = await q("SELECT * FROM VendorCredit ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 10")
dump("VendorCredit (recent 10)", vc.VendorCredit)

const bp = await q("SELECT * FROM BillPayment ORDERBY MetaData.LastUpdatedTime DESC MAXRESULTS 10")
dump("BillPayment (recent 10) — look for one whose Line[].LinkedTxn includes a VendorCredit", bp.BillPayment)

const bill = await q(`SELECT * FROM Bill WHERE DocNumber = '${billDoc.replace(/'/g, "\\'")}'`)
dump(`Bill DocNumber=${billDoc}`, bill.Bill)
