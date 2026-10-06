import { z } from "zod"
import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { createTransmittalSchema } from "@/lib/validation/transmittals"
import { changeOrderInputSchema } from "@/lib/validation/change-orders"
import { commitmentInputSchema } from "@/lib/validation/commitments"
import { allowed } from "@/lib/mobile/workspace"
import { punchAssignmentChoices } from "@/lib/mobile/workspace-punch"

/** Repeated native form rows are bounded JSON strings, never arbitrary service inputs. */
export function parseWorkspaceRows(value: unknown) {
  if (typeof value !== "string" || value.length > 10000) throw new MobileAPIError(422, "invalid_rows", "The item list is missing or too large.")
  let decoded: unknown
  try { decoded = JSON.parse(value) } catch { throw new MobileAPIError(422, "invalid_rows", "The item list could not be read.") }
  return z.array(z.record(z.string().max(10000))).min(1).max(100).parse(decoded)
}

const numeric = (value: unknown, fallback?: number) => value === undefined || value === "" ? fallback : Number(value)
const cents = (value: unknown) => {
  const amount = z.coerce.number().finite().min(0).max(1_000_000_000).parse(value)
  return Math.round(amount * 100)
}

/** The workspace entry point verifies project visibility, module and write permission. */
export async function createWorkspaceDocument(context: MobileOrgContext, moduleId: string, projectId: string | undefined, input: Record<string, unknown>) {
  if (!projectId) throw new MobileAPIError(422, "project_required", "Choose a project before creating this document.")
  const orgId = context.orgId
  if (moduleId === "transmittals") {
    const items = parseWorkspaceRows(input.items).map(row => ({ description: row.description, copies: numeric(row.copies, 1), file_id: row.file_id && row.file_id !== "none" ? row.file_id : undefined }))
    const recipients = parseWorkspaceRows(input.recipients).map(row => ({ email: row.email?.trim(), display_name: row.display_name?.trim(), company_name: row.company_name }))
    const parsed = createTransmittalSchema.parse({ project_id: projectId, subject: input.subject, purpose: input.purpose, notes: input.notes, items, recipients })
    const ids = [...new Set(parsed.items.flatMap(item => item.file_id ? [item.file_id] : []))]
    if (ids.length) {
      if (!await allowed(context, "docs.read", projectId)) throw new MobileAPIError(403, "files_forbidden", "You cannot attach project documents.")
      const { data, error } = await context.serviceSupabase.from("files").select("id").eq("org_id", orgId).eq("project_id", projectId).is("archived_at", null).in("id", ids)
      if (error) throw new MobileAPIError(500, "files_unavailable", "Enclosures could not be checked.")
      if ((data ?? []).length !== ids.length) throw new MobileAPIError(422, "invalid_enclosure", "An enclosure is no longer available in this project.")
    }
    return (await import("@/lib/services/transmittals")).createTransmittal(parsed, orgId)
  }
  if (moduleId === "change-orders") {
    const lines = parseWorkspaceRows(input.lines).map(row => ({ description: row.description, quantity: numeric(row.quantity), unit: row.unit || "unit", unit_cost: numeric(row.unit_cost), taxable: row.taxable !== "false" }))
    for (const line of lines) {
      z.number().finite().positive().max(1_000_000).parse(line.quantity)
      z.number().finite().min(-1_000_000_000).max(1_000_000_000).parse(line.unit_cost)
      if (!Number.isSafeInteger(Math.round(line.quantity! * line.unit_cost! * 100))) throw new MobileAPIError(422, "amount_too_large", "A line amount is too large.")
    }
    const parsed = changeOrderInputSchema.parse({ project_id: projectId, title: input.title, summary: input.summary, description: input.description, days_impact: numeric(input.days_impact, 0), tax_rate: numeric(input.tax_rate, 0), markup_percent: numeric(input.markup_percent, 0), lines, status: "draft", lifecycle: "draft", client_visible: false })
    return (await import("@/lib/services/change-orders")).createChangeOrder({ input: parsed, orgId })
  }
  if (moduleId === "commitments") {
    const companies = await punchAssignmentChoices(context, projectId)
    if (!companies.some(company => company.id === input.company_id)) throw new MobileAPIError(422, "invalid_company", "Choose a company assigned to this project.")
    const start = input.start_date ? z.string().date().parse(input.start_date) : undefined
    const end = input.end_date ? z.string().date().parse(input.end_date) : undefined
    if (start && end && start > end) throw new MobileAPIError(422, "invalid_dates", "Finish must be on or after the start date.")
    const parsed = commitmentInputSchema.parse({ project_id: projectId, company_id: input.company_id, commitment_type: input.commitment_type, title: input.title, total_cents: cents(input.total), contract_number: input.contract_number, scope: input.scope, terms: input.terms, retainage_percent: numeric(input.retainage_percent, 0), start_date: start, end_date: end, status: "draft" })
    return (await import("@/lib/services/commitments")).createCommitment({ input: parsed, orgId })
  }
  if (moduleId === "bids") {
    return (await import("@/lib/services/bids")).createBidPackage({ orgId, input: { project_id: projectId, title: z.string().trim().min(2).max(500).parse(input.title), trade: input.trade, scope: input.scope, instructions: input.instructions, mode: input.mode, status: "draft" } })
  }
  throw new MobileAPIError(405, "create_unavailable", "Creation is not available for this document.")
}
