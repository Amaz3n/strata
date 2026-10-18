import "server-only"

import { z } from "zod"

import { requireBooksAuthorization } from "@/lib/services/books/access"
import { normalizeBankRuleValue } from "@/lib/services/books/bank-rule-matching"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const manualRuleInputSchema = z.object({
  matchKind: z.enum(["merchant_exact", "description_contains"]),
  matchValue: z.string().trim().min(2).max(160),
  direction: z.enum(["inflow", "outflow"]).nullable(),
  bankAccountId: z.string().uuid().nullable(),
  glAccountId: z.string().uuid(),
  vendorId: z.string().uuid().nullable(),
})

export type BankManualRuleInput = z.infer<typeof manualRuleInputSchema>

const listRowSchema = z.object({
  id: z.string().uuid(),
  match_kind: z.enum(["merchant_exact", "description_contains"]),
  match_value: z.string(),
  direction: z.enum(["inflow", "outflow"]).nullable(),
  bank_account_id: z.string().uuid().nullable(),
  gl_account_id: z.string().uuid(),
  vendor_id: z.string().uuid().nullable(),
  active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
  account: z.union([z.object({ code: z.string(), name: z.string() }), z.array(z.object({ code: z.string(), name: z.string() }))]),
  bank_account: z.union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))]).nullable(),
  vendor: z.union([z.object({ name: z.string() }), z.array(z.object({ name: z.string() }))]).nullable(),
})

function isPendingSchema(error: { code?: string } | null) {
  return error?.code === "42P01" || error?.code === "PGRST205"
}

function pendingSchemaError() {
  return new Error("Manual bank rules are not available until the pending database migration is approved and applied.")
}

async function requireContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireBooksAuthorization({
    permission: "books.reconcile",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "bank_manual_rule",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

export async function listBankManualRules(orgId?: string) {
  const context = await requireContext(orgId)
  const service = createServiceSupabaseClient()
  const { data, error } = await service
    .from("bank_manual_rules")
    .select("id,match_kind,match_value,direction,bank_account_id,gl_account_id,vendor_id,active,created_at,updated_at,account:gl_accounts!inner(code,name),bank_account:bank_accounts(name),vendor:companies(name)")
    .eq("org_id", context.orgId)
    .order("created_at", { ascending: false })
    .limit(200)
  if (isPendingSchema(error)) return []
  if (error) throw new Error(`Failed to load manual bank rules: ${error.message}`)
  return z.array(listRowSchema).parse(data ?? []).map((row) => {
    const account = Array.isArray(row.account) ? row.account[0] : row.account
    const bankAccount = Array.isArray(row.bank_account) ? row.bank_account[0] : row.bank_account
    const vendor = Array.isArray(row.vendor) ? row.vendor[0] : row.vendor
    return {
      id: row.id,
      matchKind: row.match_kind,
      matchValue: row.match_value,
      direction: row.direction,
      bankAccountId: row.bank_account_id,
      bankAccountName: bankAccount?.name ?? null,
      glAccountId: row.gl_account_id,
      accountCode: account.code,
      accountName: account.name,
      vendorId: row.vendor_id,
      vendorName: vendor?.name ?? null,
      active: row.active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  })
}

export type BankManualRuleListing = Awaited<ReturnType<typeof listBankManualRules>>

async function validateReferences(orgId: string, input: BankManualRuleInput) {
  const service = createServiceSupabaseClient()
  const [account, bankAccount, vendor] = await Promise.all([
    service.from("gl_accounts").select("id").eq("org_id", orgId).eq("id", input.glAccountId).eq("active", true).neq("account_type", "cogs").maybeSingle(),
    input.bankAccountId
      ? service.from("bank_accounts").select("id").eq("org_id", orgId).eq("id", input.bankAccountId).maybeSingle()
      : Promise.resolve({ data: { id: null }, error: null }),
    input.vendorId
      ? service.from("companies").select("id").eq("org_id", orgId).eq("id", input.vendorId).maybeSingle()
      : Promise.resolve({ data: { id: null }, error: null }),
  ])
  if (account.error || !account.data) throw new Error("Choose a non-project category from this organization.")
  if (bankAccount.error || !bankAccount.data) throw new Error("Bank account not found in this organization.")
  if (vendor.error || !vendor.data) throw new Error("Vendor not found in this organization.")
}

function toRow(orgId: string, userId: string, input: BankManualRuleInput) {
  return {
    org_id: orgId,
    match_kind: input.matchKind,
    match_value: normalizeBankRuleValue(input.matchValue),
    direction: input.direction,
    bank_account_id: input.bankAccountId,
    gl_account_id: input.glAccountId,
    vendor_id: input.vendorId,
    updated_by: userId,
  }
}

export async function createBankManualRule(input: BankManualRuleInput & { orgId?: string }) {
  const parsed = manualRuleInputSchema.parse(input)
  const context = await requireContext(input.orgId)
  await validateReferences(context.orgId, parsed)
  const row = toRow(context.orgId, context.userId, parsed)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("bank_manual_rules")
    .insert({ ...row, created_by: context.userId }).select("id").single()
  if (isPendingSchema(error)) throw pendingSchemaError()
  if (error || !data) throw new Error(error?.code === "23505" ? "A manual rule with this condition and scope already exists." : `Failed to create manual bank rule: ${error?.message ?? "no row returned"}`)
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "bank_manual_rule", entityId: data.id, after: row, source: "books.bank_manual_rules" }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.bank_manual_rule_created", entityType: "bank_manual_rule", entityId: data.id, payload: { match_kind: parsed.matchKind } }),
  ])
  return { id: data.id }
}

export async function updateBankManualRule(input: BankManualRuleInput & { ruleId: string; orgId?: string }) {
  const parsed = manualRuleInputSchema.parse(input)
  const ruleId = z.string().uuid().parse(input.ruleId)
  const context = await requireContext(input.orgId)
  await validateReferences(context.orgId, parsed)
  const service = createServiceSupabaseClient()
  const { data: before, error: beforeError } = await service.from("bank_manual_rules").select("*").eq("org_id", context.orgId).eq("id", ruleId).maybeSingle()
  if (isPendingSchema(beforeError)) throw pendingSchemaError()
  if (beforeError || !before) throw new Error("Manual bank rule not found.")
  const row = toRow(context.orgId, context.userId, parsed)
  const { data, error } = await service.from("bank_manual_rules").update(row).eq("org_id", context.orgId).eq("id", ruleId).select("id").maybeSingle()
  if (error || !data) throw new Error(error?.code === "23505" ? "A manual rule with this condition and scope already exists." : `Failed to update manual bank rule: ${error?.message ?? "not found"}`)
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "bank_manual_rule", entityId: ruleId, before, after: row, source: "books.bank_manual_rules" }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.bank_manual_rule_updated", entityType: "bank_manual_rule", entityId: ruleId }),
  ])
  return { id: ruleId }
}

export async function setBankManualRuleActive(input: { ruleId: string; active: boolean; orgId?: string }) {
  const parsed = z.object({ ruleId: z.string().uuid(), active: z.boolean() }).parse(input)
  const context = await requireContext(input.orgId)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("bank_manual_rules").update({ active: parsed.active, updated_by: context.userId })
    .eq("org_id", context.orgId).eq("id", parsed.ruleId).select("id").maybeSingle()
  if (isPendingSchema(error)) throw pendingSchemaError()
  if (error || !data) throw new Error(`Failed to ${parsed.active ? "resume" : "pause"} manual bank rule: ${error?.message ?? "not found"}`)
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "bank_manual_rule", entityId: parsed.ruleId, after: { active: parsed.active }, source: "books.bank_manual_rules" }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.bank_manual_rule_updated", entityType: "bank_manual_rule", entityId: parsed.ruleId, payload: { active: parsed.active } }),
  ])
  return { id: parsed.ruleId, active: parsed.active }
}

export async function deleteBankManualRule(input: { ruleId: string; orgId?: string }) {
  const ruleId = z.string().uuid().parse(input.ruleId)
  const context = await requireContext(input.orgId)
  const service = createServiceSupabaseClient()
  const { data: before, error: beforeError } = await service.from("bank_manual_rules").select("*").eq("org_id", context.orgId).eq("id", ruleId).maybeSingle()
  if (isPendingSchema(beforeError)) throw pendingSchemaError()
  if (beforeError || !before) throw new Error("Manual bank rule not found.")
  const { error } = await service.from("bank_manual_rules").delete().eq("org_id", context.orgId).eq("id", ruleId)
  if (error) throw new Error(`Failed to delete manual bank rule: ${error.message}`)
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "delete", entityType: "bank_manual_rule", entityId: ruleId, before, source: "books.bank_manual_rules" }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.bank_manual_rule_deleted", entityType: "bank_manual_rule", entityId: ruleId }),
  ])
  return { deleted: true as const }
}
