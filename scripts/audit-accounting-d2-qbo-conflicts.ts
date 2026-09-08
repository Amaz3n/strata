import { closeSync, openSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { decryptToken } from "@/lib/integrations/accounting/qbo/auth"
import { qboCompanyBaseUrl, qboEnvironmentLabel } from "@/lib/integrations/accounting/qbo/config"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { classifyRemoteAccounts, inspectRemoteTransaction } from "./lib/accounting-d2-remote-evidence"

const EXPECTED_ORG = "eda817f7-b343-46e4-ad17-f61d9fe2e30d"
const EXPECTED_CONNECTION = "e6e4122f-bd9e-480c-b03d-6d4a8cba2eb6"
const EXPECTED_REALM = "9341456671106880"
const MIN_TOKEN_LIFETIME_MS = 20 * 60 * 1000
const DEADLINE_MS = 12 * 60 * 1000
const MAX_REQUESTS = 200
const PAGE_SIZE = 500
const MAX_ROWS = 20_000
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function referenceId(coding: unknown, key: string): string | null { const id = object(object(coding)[key]).id; return typeof id === "string" ? id : null }

async function run() {
  const outputPath = process.argv[2]
  if (!outputPath || process.argv.length !== 3) throw new Error("Usage: audit-accounting-d2-qbo-conflicts <new-private-evidence.json>")
  if (qboEnvironmentLabel !== "production") throw new Error("Audit requires an explicitly configured production QBO endpoint")
  const service = createServiceSupabaseClient()
  const { data: connection, error } = await service.from("accounting_connections")
    .select("id,org_id,external_account_id,access_token,token_expires_at,updated_at")
    .eq("org_id", EXPECTED_ORG).eq("id", EXPECTED_CONNECTION).eq("provider", "qbo").eq("status", "active").single()
  if (error || !connection || connection.external_account_id !== EXPECTED_REALM) throw new Error("Expected Patagonia connection/realm identity changed or is not active")
  const expires = Date.parse(connection.token_expires_at ?? "")
  if (!Number.isFinite(expires) || expires - Date.now() < MIN_TOKEN_LIFETIME_MS) throw new Error("Audit aborted: token lifetime cannot guarantee a no-refresh read")
  const started = Date.now()
  const deadline = started + DEADLINE_MS
  const readRows = async (table: string, columns: string) => {
    const rows: Array<Record<string, unknown>> = []
    for (let offset = 0; offset <= MAX_ROWS; offset += PAGE_SIZE) {
      if (Date.now() >= deadline) throw new Error("Database census exceeded audit deadline")
      const { data, error, count } = await service.from(table).select(columns, { count: "exact" }).eq("org_id", EXPECTED_ORG).order("id").range(offset, offset + PAGE_SIZE - 1)
      if (error || count === null || count > MAX_ROWS) throw new Error(`Incomplete ${table} census; no evidence can qualify`)
      const page = data ?? []
      rows.push(...page as unknown as Array<Record<string, unknown>>)
      if (rows.length >= count) { if (rows.length !== count) throw new Error("Census changed during audit; retry from a fresh snapshot"); return rows }
      if (page.length < PAGE_SIZE) throw new Error("Database row cap prevented a complete audit")
    }
    throw new Error("Audit row budget exceeded")
  }
  const [expenses, bills, syncRows] = await Promise.all([
    readRows("project_expenses", "id,updated_at,qbo_expense_account_id,accounting_coding"),
    readRows("vendor_bills", "id,updated_at,metadata,qbo_expense_account_id,accounting_coding"),
    readRows("accounting_sync_records", "id,entity_id,entity_type,connection_id,external_id,external_version,updated_at"),
  ])
  const sourceCandidates: Array<Record<string, unknown> & { kind: string }> = [...expenses.map(row => ({ ...row, kind: "project_expense" })), ...bills.map(row => ({ ...row, kind: object(row.metadata).source === "vendor_credit" ? "vendor_credit" : "bill" }))]
  const candidates: Array<Record<string, unknown> & { kind: string; neutral: string; legacy: string }> = sourceCandidates
    .flatMap(row => { const neutral = referenceId(row.accounting_coding, "expense_account"); const legacy = row.qbo_expense_account_id; return neutral && typeof legacy === "string" && neutral !== legacy ? [{ ...row, neutral, legacy }] : [] })
  const fd = openSync(resolve(outputPath), "wx", 0o600)
  let requests = 0
  const accessToken = decryptToken(connection.access_token)
  const cache = new Map<string, unknown>()
  const remoteRead = async (kind: string, externalId: string): Promise<unknown> => {
    const key = `${kind}:${externalId}`
    if (cache.has(key)) return cache.get(key)
    if (++requests > MAX_REQUESTS || Date.now() >= deadline || expires - Date.now() < 5 * 60 * 1000) throw new Error("audit_budget_exceeded")
    const response = await fetch(`${qboCompanyBaseUrl}/${encodeURIComponent(EXPECTED_REALM)}/${kind.toLowerCase()}/${encodeURIComponent(externalId)}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(Math.min(15_000, deadline - Date.now())),
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    })
    if (response.status === 404) { cache.set(key, null); return null }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const faults = object(object(body).Fault).Error
      const codes = Array.isArray(faults) ? faults.map(fault => String(object(fault).code ?? "")).filter(code => /^\d{1,6}$/.test(code)).slice(0, 5) : []
      throw new Error(`remote_http_${response.status}${codes.length ? `_code_${codes.join("_")}` : ""}`)
    }
    const payload: unknown = await response.json()
    const transaction = object(payload)[kind]
    if (!transaction || object(transaction).Id !== externalId) throw new Error("remote_identity_or_payload_mismatch")
    cache.set(key, transaction)
    return transaction
  }
  const records: Array<Record<string, unknown>> = []
  try {
    for (const candidate of candidates) {
      const sync = syncRows.filter(row => row.connection_id === EXPECTED_CONNECTION && row.entity_type === candidate.kind && row.entity_id === candidate.id)
      const result: Record<string, unknown> = { orgId: EXPECTED_ORG, connectionId: EXPECTED_CONNECTION, entityType: candidate.kind, entityId: candidate.id, localUpdatedAt: candidate.updated_at, neutralAccountId: candidate.neutral, legacyAccountId: candidate.legacy, reviewer: null, disposition: "unreviewed", complete: false }
      records.push(result)
      if (sync.length !== 1 || typeof sync[0].external_id !== "string" || !sync[0].external_id) { result.error = "missing_or_ambiguous_neutral_identity"; continue }
      result.externalId = sync[0].external_id
      result.localExternalVersion = sync[0].external_version
      result.syncUpdatedAt = sync[0].updated_at
      const kind = candidate.kind === "project_expense" ? object(candidate.accounting_coding).transaction_type === "bill" ? "Bill" : "Purchase" : object(candidate.metadata).source === "vendor_credit" ? "VendorCredit" : "Bill"
      try {
        const raw = await remoteRead(kind, sync[0].external_id)
        if (!raw) { result.error = "missing_remote_transaction"; continue }
        const remote = inspectRemoteTransaction(raw)
        const accounts: string[] = []
        const allocations = []
        for (const line of remote.lines) {
          let expenseAccountId = line.accountId
          if (line.itemId) expenseAccountId = String(object(object(await remoteRead("Item", line.itemId)).ExpenseAccountRef).value ?? "") || null
          if (expenseAccountId) accounts.push(expenseAccountId)
          allocations.push({ ...line, expenseAccountId })
        }
        result.remote = { ...remote, lines: allocations }
        result.accountMatch = classifyRemoteAccounts(candidate.neutral, candidate.legacy, accounts)
        result.complete = remote.complete && allocations.every(line => !["AccountBasedExpenseLineDetail", "ItemBasedExpenseLineDetail"].includes(line.detailType ?? "") || !!line.expenseAccountId)
      } catch (error) {
        // Deliberately omit provider payloads and exception stacks from the packet.
        result.error = error instanceof Error && /^(remote_http_\d+(?:_code_[0-9_]+)?|audit_budget_exceeded|remote_identity_or_payload_mismatch)$/.test(error.message) ? error.message : "remote_read_failed"
      }
    }
    const complete = records.every(row => row.complete === true)
    writeFileSync(fd, `${JSON.stringify({ version: "accounting-d2-remote-v1", readOnly: true, noRefresh: true, capturedAt: new Date().toISOString(), connectionId: EXPECTED_CONNECTION, realmId: EXPECTED_REALM, requests, complete, checkedCounts: { expenses: expenses.length, bills: bills.length, syncRows: syncRows.length, candidates: candidates.length }, records }, null, 2)}\n`)
    process.stdout.write(`Read-only evidence written: ${records.length} records, complete=${complete}, requests=${requests}.\n`)
    if (!complete) process.exitCode = 1
  } finally { closeSync(fd) }
}
void run().catch(() => { console.error("Read-only QBO audit failed. Check runtime, identity, token lifetime, output path and complete scan prerequisites; no refresh or production mutations were attempted."); process.exitCode = 1 })
