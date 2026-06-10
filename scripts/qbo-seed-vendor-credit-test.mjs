#!/usr/bin/env node
// SANDBOX SEED: create the vendor + bill + vendor credit(s) needed to capture the
// "vendor credit applied to a bill" payload. Creates QBO objects in the connected
// SANDBOX company only. Idempotent by DocNumber/name (re-running won't duplicate).
//
//   node --env-file=.env.local scripts/qbo-seed-vendor-credit-test.mjs [orgId]
//
// After running: in the QBO sandbox UI do Pay Bills on ARC-BILL-1, apply the $200
// ARC-VC-1 credit (cash = $800). Then run scripts/qbo-dump-vendor-credits.mjs.

import { createDecipheriv } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const SANDBOX_API_BASE = "https://sandbox-quickbooks.api.intuit.com/v3/company"
const PROD_API_BASE = "https://quickbooks.api.intuit.com/v3/company"

const argOrgId = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null

const sandboxEnv = (process.env.QBO_SANDBOX ?? "").trim().toLowerCase()
const isSandbox = ["1", "true", "yes", "on"].includes(sandboxEnv)
  ? true
  : ["0", "false", "no", "off"].includes(sandboxEnv)
    ? false
    : process.env.NODE_ENV !== "production"
if (!isSandbox) {
  console.error("Refusing to run: not pointed at sandbox (set QBO_SANDBOX=true). This script writes data.")
  process.exit(1)
}
const API_BASE = SANDBOX_API_BASE

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

let connQuery = supabase
  .from("qbo_connections")
  .select("org_id, realm_id, access_token")
  .eq("status", "active")
if (argOrgId) connQuery = connQuery.eq("org_id", argOrgId)
const { data: rows, error } = await connQuery
if (error || !rows?.length) {
  console.error("No active qbo_connection:", error?.message ?? "none found")
  process.exit(1)
}
if (rows.length > 1) {
  console.error("Multiple active connections — pass orgId:", rows.map((r) => r.org_id).join(", "))
  process.exit(1)
}
const conn = rows[0]
const token = decryptToken(conn.access_token)
console.log(`sandbox | org ${conn.org_id} | realm ${conn.realm_id}\n`)

async function qboGet(query) {
  const url = `${API_BASE}/${conn.realm_id}/query?query=${encodeURIComponent(query)}&minorversion=73`
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } })
  if (!resp.ok) throw new Error(`GET ${query} -> ${resp.status} ${(await resp.text()).slice(0, 400)}`)
  return (await resp.json()).QueryResponse ?? {}
}
async function qboPost(entity, body) {
  const url = `${API_BASE}/${conn.realm_id}/${entity}?minorversion=73`
  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`POST ${entity} -> ${resp.status} ${(await resp.text()).slice(0, 600)}`)
  return await resp.json()
}

// 1. Pick an expense account.
const expenseAccts = (await qboGet("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1")).Account ?? []
if (!expenseAccts.length) throw new Error("No expense account in sandbox")
const expenseRef = { value: expenseAccts[0].Id, name: expenseAccts[0].Name }
console.log(`expense account: ${expenseRef.name} (${expenseRef.value})`)

// 2. Pick a customer linked to an Arc project (so the line allocates), else any customer, else none.
let customerRef = null
const { data: projRows } = await supabase
  .from("projects")
  .select("name, qbo_customer_id")
  .eq("org_id", conn.org_id)
  .not("qbo_customer_id", "is", null)
  .limit(1)
const linkedCustomerId = projRows?.[0]?.qbo_customer_id ? String(projRows[0].qbo_customer_id) : null
if (linkedCustomerId) {
  const found = (await qboGet(`SELECT * FROM Customer WHERE Id = '${linkedCustomerId}'`)).Customer ?? []
  if (found.length) customerRef = { value: found[0].Id, name: found[0].DisplayName }
}
if (!customerRef) {
  const anyCust = (await qboGet("SELECT * FROM Customer MAXRESULTS 1")).Customer ?? []
  if (anyCust.length) customerRef = { value: anyCust[0].Id, name: anyCust[0].DisplayName }
}
console.log(customerRef ? `customer/project: ${customerRef.name} (${customerRef.value})` : "customer/project: none")

// 3. Find-or-create vendor.
let vendor = (await qboGet("SELECT * FROM Vendor WHERE DisplayName = 'Arc Credit Test'")).Vendor?.[0]
if (!vendor) vendor = (await qboPost("vendor", { DisplayName: "Arc Credit Test" })).Vendor
const vendorRef = { value: vendor.Id, name: vendor.DisplayName }
console.log(`vendor: ${vendorRef.name} (${vendorRef.value})`)

function expenseLine(amount, desc) {
  const detail = { AccountRef: expenseRef }
  if (customerRef) detail.CustomerRef = customerRef
  return { DetailType: "AccountBasedExpenseLineDetail", Amount: amount, Description: desc, AccountBasedExpenseLineDetail: detail }
}

// 4. Bill ARC-BILL-1 ($1000).
let bill = (await qboGet("SELECT * FROM Bill WHERE DocNumber = 'ARC-BILL-1'")).Bill?.[0]
if (!bill) {
  bill = (await qboPost("bill", {
    VendorRef: vendorRef,
    DocNumber: "ARC-BILL-1",
    Line: [expenseLine(1000, "Arc credit test bill")],
  })).Bill
  console.log(`created Bill ARC-BILL-1 (${bill.Id}) total ${bill.TotalAmt}`)
} else {
  console.log(`Bill ARC-BILL-1 already exists (${bill.Id})`)
}

// 5. Vendor Credit ARC-VC-1 ($200, to be applied in the UI).
let vc1 = (await qboGet("SELECT * FROM VendorCredit WHERE DocNumber = 'ARC-VC-1'")).VendorCredit?.[0]
if (!vc1) {
  vc1 = (await qboPost("vendorcredit", {
    VendorRef: vendorRef,
    DocNumber: "ARC-VC-1",
    Line: [expenseLine(200, "Arc credit test - to apply")],
  })).VendorCredit
  console.log(`created VendorCredit ARC-VC-1 (${vc1.Id}) total ${vc1.TotalAmt}`)
} else {
  console.log(`VendorCredit ARC-VC-1 already exists (${vc1.Id})`)
}

// 6. Standalone Vendor Credit ARC-VC-2 ($150, leave unapplied).
let vc2 = (await qboGet("SELECT * FROM VendorCredit WHERE DocNumber = 'ARC-VC-2'")).VendorCredit?.[0]
if (!vc2) {
  vc2 = (await qboPost("vendorcredit", {
    VendorRef: vendorRef,
    DocNumber: "ARC-VC-2",
    Line: [expenseLine(150, "Arc credit test - standalone")],
  })).VendorCredit
  console.log(`created VendorCredit ARC-VC-2 (${vc2.Id}) total ${vc2.TotalAmt}`)
} else {
  console.log(`VendorCredit ARC-VC-2 already exists (${vc2.Id})`)
}

console.log("\nNEXT (manual, in QBO sandbox UI):")
console.log("  + New  ->  Pay bills")
console.log("  Pick vendor 'Arc Credit Test', select bill ARC-BILL-1.")
console.log("  Apply the ARC-VC-1 $200 credit so the payment amount drops to $800. Save.")
console.log("  Then run: node --env-file=.env.local scripts/qbo-dump-vendor-credits.mjs")
