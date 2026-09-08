/** Read-only review packet. Never treats a remote match as accounting authority. */
export type EvidenceRow = Record<string, unknown>
export type DecisionEvidence = {
  captured_at: string
  coding: EvidenceRow[]
  jobs: EvidenceRow[]
  sync_issues: EvidenceRow[]
  inbound: EvidenceRow[]
  connections: EvidenceRow[]
  routes: EvidenceRow[]
  sync_identities?: EvidenceRow[]
  counterparty_links?: EvidenceRow[]
}
export type Decision = {
  key: string
  orgId: string | null
  connectionId: string | null
  entityType: string
  entityId: string
  externalId: string | null
  sources: Array<{ kind: string; id: string; observedAt: string; version: string | null; status: string | null }>
  findings: string[]
  before: EvidenceRow[]
  proposedAction: string
  reviewer: string | null
  disposition: "unreviewed"
  expectedAfterState: string
}
function str(value: unknown): string | null { return typeof value === "string" && value.length > 0 ? value : null }
function obj(value: unknown): EvidenceRow { return value && typeof value === "object" && !Array.isArray(value) ? value as EvidenceRow : {} }
function entityType(type: unknown): string {
  return ({ expense: "project_expense", vendor_bill: "bill", Purchase: "project_expense", Bill: "bill", VendorCredit: "vendor_credit", Invoice: "invoice", Payment: "payment", BillPayment: "bill_payment" } as Record<string, string>)[String(type)] ?? String(type)
}
export function codingDifferences(row: EvidenceRow): string[] {
  const coding = obj(row.accounting_coding)
  const fields = [
    ["legacy_expense_account_id", obj(coding.expense_account).id, "expense_account"],
    ["legacy_payment_account_id", obj(coding.payment_account).id, "payment_account"],
    ["legacy_ap_account_id", obj(coding.ap_account).id, "ap_account"],
    ["legacy_vendor_id", obj(coding.counterparty).id, "counterparty"],
    ["legacy_class_id", obj(obj(coding.dimensions).class).id, "class"],
  ]
  return fields.flatMap(([legacyKey, neutral, name]) => {
    const legacy = str(row[String(legacyKey)])
    return !legacy || legacy === neutral ? [] : [`${name}:${str(neutral) ? "conflicting_values" : "missing_direct_neutral_reference"}`]
  })
}
export function buildDecisionRegister(input: DecisionEvidence): { version: string; capturedAt: string; readOnly: true; entries: Decision[]; unresolvedCount: number } {
  if (!Number.isFinite(Date.parse(input.captured_at))) throw new Error("Evidence capture time is required")
  const entries = new Map<string, Decision>()
  const syncRows = [...input.sync_issues, ...(input.sync_identities ?? [])]
  const connectionFor = (orgId: string | null, type: string, id: string): string | null => {
    const identities = [...new Set(syncRows.filter(r => r.org_id === orgId && entityType(r.entity_type) === type && r.entity_id === id).map(r => str(r.connection_id)).filter(Boolean))]
    return identities.length === 1 ? identities[0] : null
  }
  const add = (row: EvidenceRow, kind: string, type: string, id: string, orgId: string | null, connectionId: string | null, findings: string[], before: EvidenceRow = {}) => {
    const key = JSON.stringify([orgId, connectionId, type, id])
    let entry = entries.get(key)
    if (!entry) {
      entry = { key, orgId, connectionId, entityType: type, entityId: id, externalId: str(row.external_id ?? row.legacy_external_id ?? row.entity_qbo_id), sources: [], findings: [], before: [], proposedAction: "Inspect source/audit and complete remote evidence; determine accounting intent before proposing a conditional repair.", reviewer: null, disposition: "unreviewed", expectedAfterState: "Approved neutral identity/coding and immutable money facts preserved; approved retries or historical disposition leave no actionable issue." }
      entries.set(key, entry)
    }
    if (!entry.sources.some(source => source.kind === kind && source.id === String(row.id ?? id))) entry.sources.push({ kind, id: String(row.id ?? id), observedAt: str(row.updated_at ?? row.last_updated ?? row.received_at) ?? input.captured_at, version: str(row.external_version), status: str(row.status ?? row.process_status) })
    entry.findings = [...new Set([...entry.findings, ...findings])].sort()
    if (Object.keys(before).length) entry.before.push(before)
    if (kind === "connection") {
      entry.proposedAction = orgId === "eda817f7-b343-46e4-ad17-f61d9fe2e30d" ? "Preserve predecessor connection as history; review all foreign-key and indirect references before any disposition." : "Review test/historical classification and all foreign-key and indirect references; approve explicit exclusion or preservation. Do not delete by status alone."
    }
  }
  for (const row of input.coding) {
    const type = obj(row.metadata).source === "vendor_credit" ? "vendor_credit" : entityType(row.entity_type)
    const connectionId = connectionFor(str(row.org_id), type, String(row.id))
    const differences = codingDifferences(row).filter(finding => {
      if (finding !== "counterparty:missing_direct_neutral_reference") return true
      return !(input.counterparty_links ?? []).some(link => link.org_id === row.org_id && link.connection_id === connectionId && link.role === "vendor" && link.entity_type === "company" && link.entity_id === (row.company_id ?? row.vendor_company_id ?? row.vendor_id) && link.external_id === row.legacy_vendor_id)
    })
    if (!differences.length) continue
    add(row, "coding", type, String(row.id), str(row.org_id), connectionFor(str(row.org_id), type, String(row.id)), differences, {
      updated_at: row.updated_at ?? null, legacy_external_id: row.legacy_external_id ?? null,
      legacy_expense_account_id: row.legacy_expense_account_id ?? null, legacy_payment_account_id: row.legacy_payment_account_id ?? null,
      legacy_ap_account_id: row.legacy_ap_account_id ?? null, legacy_vendor_id: row.legacy_vendor_id ?? null,
      legacy_class_id: row.legacy_class_id ?? null, accounting_coding: row.accounting_coding,
      amount_cents: row.amount_cents ?? row.total_cents ?? null, tax_cents: row.tax_cents ?? null,
    })
  }
  for (const row of input.sync_issues) {
    const type = entityType(row.entity_type)
    add(row, "sync", type, String(row.entity_id), str(row.org_id), str(row.connection_id), [`sync:${row.status}`, ...(str(row.status_reason) ? [`reason:${row.status_reason}`] : [])], { external_id: row.external_id ?? null, external_version: row.external_version ?? null, updated_at: row.updated_at, status: row.status, status_reason: row.status_reason ?? null })
  }
  for (const row of input.jobs) {
    const payload = obj(row.payload)
    const type = entityType(String(row.job_type).replace(/^(?:accounting_push_|qbo_sync_)/, ""))
    const id = str(payload.invoice_id ?? payload.expense_id ?? payload.bill_id ?? payload.payment_id ?? payload.entity_id) ?? `job:${row.id}`
    add(row, "outbox", type, id, str(row.org_id), str(payload.connection_id ?? payload.connectionId) ?? connectionFor(str(row.org_id), type, id), [`outbox:${row.status}`], { job_id: row.id, updated_at: row.updated_at, status: row.status, retry_count: row.retry_count ?? null })
  }
  for (const row of input.inbound) {
    const type = entityType(row.entity_name)
    const connections = input.connections.filter(c => c.external_account_id === row.realm_id)
    const mapped = syncRows.filter(s => entityType(s.entity_type) === type && s.external_id === row.entity_qbo_id && connections.some(c => c.id === s.connection_id))
    const unique = new Map(mapped.map(s => [JSON.stringify([s.org_id, s.connection_id, s.entity_type, s.entity_id]), s]))
    if (unique.size) for (const sync of unique.values()) add(row, "inbound", type, String(sync.entity_id), str(sync.org_id), str(sync.connection_id), [`inbound:${row.process_status}`], { event_id: row.id, remote_updated_at: row.last_updated, operation: row.operation })
    else {
      const active = connections.filter(c => c.status === "active")
      const connection = active.length === 1 ? active[0] : connections.length === 1 ? connections[0] : null
      add(row, "inbound", type, `remote:${row.entity_qbo_id}`, str(connection?.org_id), str(connection?.id), [`inbound:${row.process_status}`, "remote_identity_not_resolved"], { event_id: row.id, remote_updated_at: row.last_updated, operation: row.operation })
    }
  }
  for (const row of input.connections.filter(c => c.status !== "active")) add(row, "connection", "accounting_connection", String(row.id), str(row.org_id), String(row.id), ["inactive_artifact_requires_disposition"], { updated_at: row.updated_at, status: row.status, external_account_id: row.external_account_id, route_refs: row.route_refs, sync_refs: row.sync_refs, counterparty_refs: row.counterparty_refs, reference_inventory_complete: false })
  return { version: "accounting-d2-decisions-v1", capturedAt: input.captured_at, readOnly: true, entries: [...entries.values()].sort((a, b) => a.key.localeCompare(b.key)), unresolvedCount: entries.size }
}
