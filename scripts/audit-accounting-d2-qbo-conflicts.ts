import { decryptToken } from "@/lib/integrations/accounting/qbo/auth"
import { qboCompanyBaseUrl, qboEnvironmentLabel } from "@/lib/integrations/accounting/qbo/config"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const ORG_NAME = "Patagonia Development LLC"
const EXPECTED_REALM = "9341456671106880"
const MIN_TOKEN_LIFETIME_MS = 20 * 60 * 1000

function referenceId(coding: unknown, key: string): string | null {
  if (!coding || typeof coding !== "object") return null
  const value = (coding as Record<string, any>)[key]
  return typeof value?.id === "string" ? value.id : null
}

function remoteExpenseAccounts(transaction: any): Set<string> {
  return new Set(
    (Array.isArray(transaction?.Line) ? transaction.Line : [])
      .map((line: any) => line?.AccountBasedExpenseLineDetail?.AccountRef?.value)
      .filter((value: unknown): value is string => typeof value === "string" && value.length > 0),
  )
}

async function run() {
  if (qboEnvironmentLabel !== "production") throw new Error("Audit requires an explicitly configured production QBO endpoint")
  const supabase = createServiceSupabaseClient()
  const { data: org, error: orgError } = await supabase.from("orgs").select("id").eq("name", ORG_NAME).single()
  if (orgError || !org) throw new Error("Patagonia organization identity was not found")

  const { data: connection, error: connectionError } = await supabase
    .from("accounting_connections")
    .select("id,external_account_id,access_token,token_expires_at")
    .eq("org_id", org.id)
    .eq("provider", "qbo")
    .eq("status", "active")
    .single()
  if (connectionError || !connection) throw new Error("Expected exactly one active Patagonia QBO connection")
  if (connection.external_account_id !== EXPECTED_REALM) throw new Error("Patagonia QBO realm identity changed")
  const tokenExpiresAt = Date.parse(connection.token_expires_at ?? "")
  if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt - Date.now() < MIN_TOKEN_LIFETIME_MS) {
    throw new Error("Audit aborted before QBO access: token lifetime is too short to guarantee a no-refresh read")
  }

  const [{ data: expenses, error: expenseError }, { data: bills, error: billError }] = await Promise.all([
    supabase
      .from("project_expenses")
      .select("id,qbo_expense_account_id,accounting_coding")
      .eq("org_id", org.id)
      .not("qbo_expense_account_id", "is", null)
      .limit(5000),
    supabase
      .from("vendor_bills")
      .select("id,metadata,qbo_expense_account_id,accounting_coding")
      .eq("org_id", org.id)
      .not("qbo_expense_account_id", "is", null)
      .limit(5000),
  ])
  if (expenseError || billError) throw new Error("Unable to load accounting-coding conflicts")

  const candidates = [
    ...(expenses ?? []).map((row) => ({ ...row, kind: "expense" as const })),
    ...(bills ?? []).map((row) => ({ ...row, kind: "bill" as const })),
  ].flatMap((row) => {
    const neutral = referenceId(row.accounting_coding, "expense_account")
    const legacy = row.qbo_expense_account_id
    const transactionType = (row.accounting_coding as { transaction_type?: string } | null)?.transaction_type ?? null
    return neutral && legacy && neutral !== legacy ? [{ ...row, neutral, legacy, transactionType }] : []
  })

  const ids = candidates.map((row) => row.id)
  const { data: syncRows, error: syncError } = await supabase
    .from("accounting_sync_records")
    .select("entity_id,entity_type,external_id")
    .eq("org_id", org.id)
    .eq("connection_id", connection.id)
    .in("entity_id", ids)
  if (syncError) throw new Error("Unable to load neutral sync identities")
  const syncByEntity = new Map((syncRows ?? []).map((row) => [row.entity_id, row]))

  const accessToken = decryptToken(connection.access_token)
  const readTransaction = async (entity: "purchase" | "bill" | "vendorcredit", externalId: string) => {
    const response = await fetch(
      `${qboCompanyBaseUrl}/${encodeURIComponent(EXPECTED_REALM)}/${entity}/${encodeURIComponent(externalId)}`,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    )
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`QBO read failed with HTTP ${response.status}`)
    const payload = await response.json() as Record<string, unknown>
    const key = entity === "purchase" ? "Purchase" : entity === "bill" ? "Bill" : "VendorCredit"
    return payload[key] ?? null
  }

  const result = {
    candidates: candidates.length,
    remote_matches_neutral_only: 0,
    remote_matches_legacy_only: 0,
    remote_contains_both: 0,
    remote_matches_neither: 0,
    missing_sync_identity: 0,
    missing_remote_transaction: 0,
    read_errors: 0,
  }

  for (const candidate of candidates) {
    const sync = syncByEntity.get(candidate.id)
    if (!sync?.external_id) {
      result.missing_sync_identity += 1
      continue
    }
    try {
      const transaction = candidate.kind === "expense"
        ? candidate.transactionType === "bill"
          ? await readTransaction("bill", sync.external_id)
          : await readTransaction("purchase", sync.external_id)
        : (candidate.metadata as { source?: string } | null)?.source === "vendor_credit"
          ? await readTransaction("vendorcredit", sync.external_id)
          : await readTransaction("bill", sync.external_id)
      if (!transaction) {
        result.missing_remote_transaction += 1
        continue
      }
      const remoteAccounts = remoteExpenseAccounts(transaction)
      const matchesNeutral = remoteAccounts.has(candidate.neutral)
      const matchesLegacy = remoteAccounts.has(candidate.legacy)
      if (matchesNeutral && matchesLegacy) result.remote_contains_both += 1
      else if (matchesNeutral) result.remote_matches_neutral_only += 1
      else if (matchesLegacy) result.remote_matches_legacy_only += 1
      else result.remote_matches_neither += 1
    } catch {
      result.read_errors += 1
    }
  }

  // Aggregate only: no customer transaction ids, account ids, names, or tokens.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
