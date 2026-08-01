import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireBooksWorkspaceEnabled } from "@/lib/services/books/module"
import { requireOrgContext } from "@/lib/services/context"

const accountTypeSchema = z.enum(["asset", "liability", "equity", "income", "cogs", "expense"])
const normalBalanceSchema = z.enum(["debit", "credit"])
const cashFlowSchema = z.enum(["operating", "investing", "financing", "cash"])

async function requireChartManager(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireBooksWorkspaceEnabled(context.orgId)
  await requireAuthorization({
    permission: "books.manage",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "gl_account",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

export async function createGlAccount(input: {
  code: string
  name: string
  accountType: string
  subtype: string
  normalBalance: string
  cashFlowCategory?: string | null
}, orgId?: string) {
  const context = await requireChartManager(orgId)
  const parsed = z.object({
    code: z.string().trim().min(1).max(32),
    name: z.string().trim().min(2).max(160),
    accountType: accountTypeSchema,
    subtype: z.string().trim().min(1).max(80).regex(/^[a-z0-9_]+$/),
    normalBalance: normalBalanceSchema,
    cashFlowCategory: cashFlowSchema.nullish(),
  }).parse(input)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("gl_accounts").insert({
    org_id: context.orgId,
    code: parsed.code,
    name: parsed.name,
    account_type: parsed.accountType,
    subtype: parsed.subtype,
    normal_balance: parsed.normalBalance,
    cash_flow_category: parsed.cashFlowCategory ?? null,
    is_system: false,
    active: true,
    created_by: context.userId,
    updated_by: context.userId,
  }).select("id").single()
  if (error) throw new Error(`Failed to create account: ${error.message}`)
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "insert",
    entityType: "gl_account",
    entityId: data.id,
    after: parsed,
    source: "books.chart",
  })
  return { id: data.id }
}

export async function setGlAccountActive(accountId: string, active: boolean, orgId?: string) {
  const context = await requireChartManager(orgId)
  const service = createServiceSupabaseClient()
  const { data: account, error: loadError } = await service
    .from("gl_accounts")
    .select("id, code, name, active, is_system")
    .eq("org_id", context.orgId)
    .eq("id", z.string().uuid().parse(accountId))
    .single()
  if (loadError) throw new Error(`Failed to load account: ${loadError.message}`)
  if (account.is_system && !active) throw new Error("System accounts cannot be deactivated")
  const { error } = await service.from("gl_accounts").update({ active, updated_by: context.userId }).eq("org_id", context.orgId).eq("id", account.id)
  if (error) throw new Error(`Failed to update account: ${error.message}`)
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "gl_account",
    entityId: account.id,
    before: { active: account.active },
    after: { active },
    source: "books.chart",
  })
  return { id: account.id, active }
}
