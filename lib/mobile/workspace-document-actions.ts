import { createHash } from "node:crypto"
import { z } from "zod"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import { MobileAPIError } from "@/lib/mobile/api"
import { allowed } from "@/lib/mobile/workspace"
import { field, section, type Action, type Field, type Section } from "@/lib/mobile/workspace-detail"
import { parseWorkspaceRows } from "@/lib/mobile/workspace-authoring"
import { commitmentLineInputSchema } from "@/lib/validation/commitments"

const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const number = (value: string, fallback?: number) => value === "" || value === undefined ? fallback : Number(value)
const money = (value: string) => Math.round(z.number().finite().min(0).max(1_000_000_000).parse(number(value)) * 100)
const lineFields = [field("description", "Description", "text", true), field("quantity", "Quantity", "number", true), field("unit", "Unit", "text", true), field("unit_price", "Unit price ($)", "number", true), field("scheduled_value", "Scheduled value ($)", "number"), field("retainage_percent", "Retainage (%)", "number")]

export async function loadDocumentActions(context: MobileOrgContext, moduleId: string, projectId: string | undefined, recordId: string) {
  const actions: Action[] = [], sections: Section[] = []
  const orgId = context.orgId
  if (moduleId === "commitments") {
    const detail = await (await import("@/lib/services/commitments")).getCommitmentDetail(recordId, orgId)
    const commitment = detail.commitment
    if (commitment.status === "draft" && await allowed(context, "commitment.write", commitment.project_id)) {
      actions.push({ id: "add-value-line", title: "Add Schedule of Values Line", revision: revision(detail.lines), fields: lineFields })
      for (const line of detail.lines) {
        const values: Record<string, string> = { description: line.description, quantity: String(line.quantity), unit: line.unit, unit_price: String(line.unit_cost_cents / 100), scheduled_value: line.scheduled_value_cents == null ? "" : String(line.scheduled_value_cents / 100), retainage_percent: line.retainage_percent == null ? "" : String(line.retainage_percent) }
        actions.push({ id: `edit-value-line:${line.id}`, title: `Edit Line: ${line.description}`, revision: revision(line), fields: lineFields.map(f => ({ ...f, value: values[f.key] })) })
        actions.push({ id: `remove-value-line:${line.id}`, title: `Remove Line: ${line.description}`, revision: revision(line), fields: [] })
      }
    }
  }
  if (moduleId === "bids") {
    const service = await import("@/lib/services/bids")
    const pkg = await service.getBidPackage(recordId, orgId)
    if (pkg.status === "draft" && await allowed(context, "bid.write", pkg.project_id ?? undefined)) {
      const scope = await service.listBidScopeItems(recordId, orgId)
      const columns: Field[] = [field("description", "Description", "text", true), { ...field("item_type", "Type", "choice", true), options: ["base", "alternate", "allowance", "unit_price"] }, field("details", "Details", "multiline"), field("quantity", "Quantity", "number"), field("unit", "Unit"), field("budget", "Budget ($)", "number")]
      const items = scope.map(item => ({ id: item.id, description: item.description, item_type: item.item_type, details: item.details ?? "", quantity: item.quantity == null ? "" : String(item.quantity), unit: item.unit ?? "", budget: item.budget_cents == null ? "" : String(item.budget_cents / 100) }))
      actions.push({ id: "edit-bid-scope", title: "Edit Scope of Work", revision: revision(scope), fields: [{ ...field("items", "Scope Items", "rows", true), fields: columns, value: JSON.stringify(items) }] })
      actions.push({ id: "edit-bid-details", title: "Edit Package Details", revision: revision(pkg), fields: [field("title", "Title", "text", true), field("trade", "Trade"), field("scope", "Scope", "multiline"), field("instructions", "Instructions", "multiline")].map(f => ({ ...f, value: String(pkg[f.key as "title" | "trade" | "scope" | "instructions"] ?? "") })) })
    }
  }
  if (moduleId === "change-orders") {
    const service = await import("@/lib/services/change-orders")
    const change = await service.fetchChangeOrder(context.serviceSupabase, { id: recordId, orgId, projectId })
    if (!change) throw new MobileAPIError(404, "record_not_found", "Change order not found.")
    sections.push(section("change-lines", "Line Items", change.lines ?? [], ["description"], [field("quantity", "Quantity", "number"), field("unit", "Unit"), field("unit_cost_cents", "Unit price", "money"), field("total_cents", "Total", "money")]))
    if (await allowed(context, "change_order.write", change.project_id)) {
      if (change.lifecycle === "draft") actions.push({ id: "start-pricing", title: "Start Pricing", fields: [], revision: revision(change) })
      if (["draft", "pricing"].includes(change.lifecycle ?? "draft")) actions.push({ id: "propose-change", title: "Propose Change Order", fields: [], revision: revision(change) })
    }
  }
  return { actions, sections }
}

/** Action membership and its revision were reloaded by performWorkspaceAction. */
export async function performDocumentAction(context: MobileOrgContext, moduleId: string, recordId: string, actionId: string, values: Record<string, string>) {
  const orgId = context.orgId
  if (moduleId === "commitments") {
    const service = await import("@/lib/services/commitments")
    if (actionId.startsWith("remove-value-line:")) return service.deleteCommitmentLine(actionId.split(":")[1])
    const input = commitmentLineInputSchema.parse({ description: values.description, quantity: z.number().finite().min(0).max(1_000_000).parse(number(values.quantity)), unit: values.unit, unit_cost_cents: money(values.unit_price), scheduled_value_cents: values.scheduled_value ? money(values.scheduled_value) : null, retainage_percent: number(values.retainage_percent) ?? null })
    if (!Number.isSafeInteger(Math.round(input.quantity * input.unit_cost_cents))) throw new MobileAPIError(422, "amount_too_large", "The line amount is too large.")
    return actionId === "add-value-line" ? service.createCommitmentLine(recordId, input) : service.updateCommitmentLine(actionId.split(":")[1], input)
  }
  if (moduleId === "bids") {
    const service = await import("@/lib/services/bids")
    if (actionId === "edit-bid-details") return service.updateBidPackage({ bidPackageId: recordId, orgId, input: { title: values.title, trade: values.trade, scope: values.scope, instructions: values.instructions } })
    const existing = await service.listBidScopeItems(recordId, orgId)
    const used = new Set<string>()
    const items = parseWorkspaceRows(values.items).map(row => {
      const previous = row.id ? existing.find(item => item.id === row.id) : undefined
      if (row.id && (!previous || used.has(row.id))) throw new MobileAPIError(422, "invalid_scope_item", "A scope item is unavailable or repeated. Reopen the editor.")
      if (row.id) used.add(row.id)
      return { id: previous?.id, cost_code_id: previous?.cost_code_id, description: row.description, item_type: row.item_type, details: row.details, quantity: row.quantity ? z.number().finite().positive().max(1_000_000).parse(Number(row.quantity)) : null, unit: row.unit || null, budget_cents: row.budget ? money(row.budget) : null }
    })
    return service.saveBidScopeItems({ orgId, input: { bid_package_id: recordId, items } })
  }
  const service = await import("@/lib/services/change-orders")
  if (actionId === "start-pricing") return service.startPricing(recordId, orgId)
  if (actionId === "propose-change") return service.proposeChangeOrder(recordId, orgId)
  throw new MobileAPIError(405, "action_unavailable", "This action is not available.")
}
