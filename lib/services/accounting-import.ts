import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getProjectReadScopeForUser } from "@/lib/services/authorization"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { listAccountingConnections, requireAccountingConnectionForOrg } from "@/lib/services/accounting-connections"
import { getProvider } from "@/lib/integrations/accounting/registry"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import type { AccountingImportItem, AccountingImportPreviewInput } from "@/lib/integrations/accounting/import"

const entitySchema = z.enum([
  "invoice",
  "expense",
  "expense_credit",
  "bill",
  "vendor_credit",
  "payment",
  "bill_payment",
  "journal_entry",
  "client_deposit",
])
const connectionSchema = z.string().uuid()
const referenceSchema = z.string().trim().min(1).max(255)
const itemSchema = z
  .object({
    externalId: referenceSchema,
    entityType: entitySchema,
    projectId: z.string().uuid().optional(),
    allocations: z.record(referenceSchema, z.string().uuid()).optional(),
    costCodes: z.record(referenceSchema, z.string().uuid()).optional(),
  })
  .strict()
const previewSchema = z
  .object({
    connectionId: connectionSchema,
    sinceDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    types: z.array(entitySchema).max(9).optional(),
  })
  .strict()

async function importContext(connectionId: string, write = false) {
  const ctx = await requireOrgContext()
  await requirePermission(write ? "bill.write" : "bill.read", ctx)
  if (write) await requirePermission("invoice.write", ctx)
  const connection = await requireAccountingConnectionForOrg(connectionSchema.parse(connectionId), ctx.orgId, { activeOnly: true })
  const provider = getProvider(connection.provider)
  if (!provider.capabilities.supportsImport || !provider.previewImport || !provider.applyImport)
    throw new Error("This accounting connection does not support imports")
  return { ...ctx, connection, provider }
}

export async function listAccountingImportConnections() {
  const ctx = await requireOrgContext()
  await requirePermission("bill.read", ctx)
  return (await listAccountingConnections(ctx.orgId))
    .filter((connection) => {
      const provider = getProvider(connection.provider)
      return connection.status === "active" && provider.capabilities.supportsImport && provider.previewImport && provider.applyImport
    })
    .map((connection) => ({
      id: connection.id,
      provider: connection.provider,
      label: connection.label,
      company: connection.external_account_name,
    }))
}

export async function previewAccountingImport(input: Omit<AccountingImportPreviewInput, "orgId">) {
  const parsed = previewSchema.parse(input)
  const ctx = await importContext(parsed.connectionId)
  if (!ctx.provider.previewImport) throw new Error("Import preview is unavailable")
  return ctx.provider.previewImport({ ...parsed, orgId: ctx.orgId })
}

export async function listAccountingImportCustomers(connectionId: string) {
  const ctx = await importContext(connectionId)
  if (!ctx.provider.listImportCustomers) throw new Error("This provider does not expose import customer dimensions")
  return ctx.provider.listImportCustomers({ orgId: ctx.orgId, connectionId })
}

export async function applyAccountingImport(input: { connectionId: string; items: AccountingImportItem[] }) {
  const parsed = z
    .object({ connectionId: connectionSchema, items: z.array(itemSchema).min(1).max(500) })
    .strict()
    .parse(input)
  const ctx = await importContext(parsed.connectionId, true)
  const projectIds = [
    ...new Set(
      parsed.items.flatMap((item) => [item.projectId, ...Object.values(item.allocations ?? {})]).filter((id): id is string => Boolean(id)),
    ),
  ]
  if (projectIds.length) {
    const { data, error } = await ctx.supabase.from("projects").select("id").eq("org_id", ctx.orgId).in("id", projectIds)
    if (error) throw new Error(`Unable to validate import destinations: ${error.message}`)
    const valid = new Set((data ?? []).map((project) => project.id))
    if (projectIds.some((id) => !valid.has(id))) throw new Error("An import destination is outside this organization")
  }
  if (!ctx.provider.applyImport) throw new Error("Import application is unavailable")
  const result = await ctx.provider.applyImport({ ...parsed, orgId: ctx.orgId })
  await Promise.all([
    recordAudit({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      action: "insert",
      entityType: "accounting_connection",
      entityId: parsed.connectionId,
      after: { imported: result.imported, skipped: result.skipped, failed: result.failed },
    }),
    recordEvent({
      orgId: ctx.orgId,
      actorId: ctx.userId,
      eventType: "accounting_import_completed",
      entityType: "accounting_connection",
      entityId: parsed.connectionId,
      payload: { provider: ctx.connection.provider, imported: result.imported, skipped: result.skipped, failed: result.failed },
      channel: "integration",
    }),
  ])
  return result
}

export async function linkAccountingImportRecord(input: {
  connectionId: string
  externalId: string
  entityType: "invoice" | "expense" | "bill"
  existingEntityId: string
}) {
  const parsed = z
    .object({
      connectionId: connectionSchema,
      externalId: referenceSchema,
      entityType: z.enum(["invoice", "expense", "bill"]),
      existingEntityId: z.string().uuid(),
    })
    .strict()
    .parse(input)
  const ctx = await importContext(parsed.connectionId, true)
  if (!ctx.provider.linkExistingImportRecord) throw new Error("This provider does not support adopting existing records")
  const table = parsed.entityType === "invoice" ? "invoices" : parsed.entityType === "bill" ? "vendor_bills" : "project_expenses"
  const { data, error } = await ctx.supabase
    .from(table)
    .select("id")
    .eq("org_id", ctx.orgId)
    .eq("id", parsed.existingEntityId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error("Existing import target is outside this organization")
  return ctx.provider.linkExistingImportRecord({ ...parsed, orgId: ctx.orgId })
}

/** Company-wide recovery candidates require the existing broad-project read scope. */
export async function listAccountingRecoveryCandidates(input: { connectionId: string; afterId?: string; limit?: number }) {
  const parsed = z
    .object({ connectionId: connectionSchema, afterId: z.string().uuid().optional(), limit: z.number().int().min(1).max(200).default(100) })
    .strict()
    .parse(input)
  const ctx = await importContext(parsed.connectionId)
  if (ctx.connection.provider !== "qbo") throw new Error("This provider does not expose CDC recovery candidates")
  const scope = await getProjectReadScopeForUser({ orgId: ctx.orgId, userId: ctx.userId })
  if (scope.projectMembershipRequired || scope.divisionIds !== null)
    throw new Error("Company-wide import candidates require organization-wide project access")
  let query = createServiceSupabaseClient()
    .from("qbo_cdc_candidates")
    .select("id, run_id, entity_name, external_id, revision, import_types, document_number, transaction_date, last_updated, review_status")
    .eq("org_id", ctx.orgId)
    .eq("connection_id", ctx.connection.id)
    .eq("realm_id", ctx.connection.external_account_id)
    .eq("review_status", "pending")
    .order("id")
    .limit(parsed.limit + 1)
  if (parsed.afterId) query = query.gt("id", parsed.afterId)
  const { data, error } = await query
  if (error) throw new Error(`Unable to load recovery candidates: ${error.message}`)
  const rows = z
    .array(
      z.object({
        id: z.string().uuid(),
        run_id: z.string().uuid(),
        entity_name: z.enum(["Invoice", "Payment", "Purchase", "Bill", "BillPayment", "VendorCredit", "JournalEntry"]),
        external_id: referenceSchema,
        revision: z.string().regex(/^[a-f0-9]{64}$/),
        import_types: z.array(entitySchema).min(1).max(2),
        document_number: z.string().max(255).nullable(),
        transaction_date: z.string().max(10).nullable(),
        last_updated: z.string().max(80).nullable(),
        review_status: z.literal("pending"),
      }),
    )
    .parse(data ?? [])
  const page = rows.slice(0, parsed.limit)
  return { candidates: page, nextAfterId: rows.length > parsed.limit ? (page.at(-1)?.id ?? null) : null }
}
