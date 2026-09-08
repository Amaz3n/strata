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
