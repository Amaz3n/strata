import "server-only"

import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export async function getBooksFundingWorkspace(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireBooksAuthorization({ permission: "books.manage", userId: context.userId, orgId: context.orgId, supabase: context.supabase })
  const service = createServiceSupabaseClient()
  const [sources, accounts] = await Promise.all([
    collectBooksRows((from,to) => service.from("org_funding_sources").select("id,bank_name,last4,status,books_gl_account_id").eq("org_id",context.orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("gl_accounts").select("id,code,name").eq("org_id",context.orgId).eq("account_type","asset").eq("subtype","cash").eq("active",true).order("code").range(from,to)),
  ])
  return { sources, accounts }
}

export async function saveBooksFundingAccount(input: { fundingSourceId: string; accountId: string; orgId?: string }) {
  const parsed = z.object({ fundingSourceId: z.string().uuid(), accountId: z.string().uuid() }).parse(input)
  const context = await requireOrgContext(input.orgId)
  await requireBooksAuthorization({ permission: "books.manage", userId: context.userId, orgId: context.orgId, supabase: context.supabase })
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("org_funding_sources").update({ books_gl_account_id: parsed.accountId }).eq("org_id",context.orgId).eq("id",parsed.fundingSourceId).select("id").single()
  if (error) throw new Error(`Failed to map funding source: ${error.message}`)
  await Promise.all([
    recordAudit({ orgId:context.orgId,actorId:context.userId,action:"update",entityType:"org_funding_source",entityId:data.id,after:{books_gl_account_id:parsed.accountId},source:"books.funding" }),
    recordEvent({ orgId:context.orgId,actorId:context.userId,eventType:"books.funding_account_mapped",entityType:"org_funding_source",entityId:data.id }),
  ])
  return { id:data.id }
}

/** Load mappings once per projection, then resolve each source without a query waterfall. */
export async function loadBooksFundingResolver(orgId: string) {
  const service = createServiceSupabaseClient()
  const [accounts, sources, disbursements, runs, payments] = await Promise.all([
    collectBooksRows((from,to) => service.from("gl_accounts").select("id,code,account_type,subtype,active").eq("org_id",orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("org_funding_sources").select("id,books_gl_account_id").eq("org_id",orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("disbursements").select("id,funding_source_id").eq("org_id",orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("payment_runs").select("id,funding_source_id").eq("org_id",orgId).order("id").range(from,to)),
    collectBooksRows((from,to) => service.from("payments").select("id,metadata,method").eq("org_id",orgId).order("id").range(from,to)),
  ])
  const byAccount = new Map(accounts.map(row => [row.id,row]))
  const bySource = new Map(sources.map(row => [row.id,row.books_gl_account_id]))
  const byDisbursement = new Map(disbursements.map(row => [row.id,row.funding_source_id]))
  const byRun = new Map(runs.map(row => [row.id,row.funding_source_id]))
  const byPayment = new Map(payments.map(row => [row.id,row]))
  const resolve = (input: { metadata?: unknown; method?: string | null; fundingSourceId?: string | null; accountId?: string | null }) => {
    const metadata = z.record(z.unknown()).catch({}).parse(input.metadata)
    if (typeof metadata.disbursement_id === "string" && !byDisbursement.has(metadata.disbursement_id)) throw new Error("The referenced disbursement is unavailable in this organization");
    if (typeof metadata.payment_run_id === "string" && !byRun.has(metadata.payment_run_id)) throw new Error("The referenced payment run is unavailable in this organization");
    const sourceId = input.fundingSourceId
      ?? (typeof metadata.funding_source_id === "string" ? metadata.funding_source_id : null)
      ?? (typeof metadata.disbursement_id === "string" ? byDisbursement.get(metadata.disbursement_id) : null)
      ?? (typeof metadata.payment_run_id === "string" ? byRun.get(metadata.payment_run_id) : null)
    const accountId = input.accountId ?? (typeof metadata.books_payment_account_id === "string" ? metadata.books_payment_account_id : null)
      ?? (sourceId ? bySource.get(sourceId) : null)
    if (sourceId && !accountId) throw new Error("Map the actual payment funding source in Books Banking")
    const card = ["credit_card","company_card","card"].includes(input.method ?? "")
    const eligible = (account: typeof accounts[number]) => card ? account.account_type === "liability" && account.subtype === "credit_card" : account.account_type === "asset" && account.subtype === "cash"
    if (accountId) {
      const account = byAccount.get(accountId)
      if (!account || !eligible(account)) throw new Error("Payment account does not match the payment method or organization")
      return account.code
    }
    const choices = accounts.filter(row => row.active && eligible(row))
    if (choices.length !== 1) throw new Error("Choose the actual bank or card account; the funding account is ambiguous")
    return choices[0].code
  }
  return { resolve, reversal(paymentId: string) {
    const payment = byPayment.get(paymentId)
    if (!payment) throw new Error("Original payment not found for funding reversal")
    return resolve({ metadata: payment.metadata, method: payment.method })
  } }
}

/** Caller owns project-level bill authorization; validate only native account identity here. */
export async function validateBooksExpensePaymentAccount(orgId: string, accountId: string) {
  z.string().uuid().parse(accountId)
  const { data, error } = await createServiceSupabaseClient().from("gl_accounts").select("id,account_type,subtype")
    .eq("org_id",orgId).eq("id",accountId).eq("active",true).single()
  if (error || !data || !((data.account_type === "asset" && data.subtype === "cash") || (data.account_type === "liability" && data.subtype === "credit_card"))) throw new Error("Choose an active native bank or card account")
}

export async function getPayableNativeFundingAccounts(billId: string) {
  const context = await requireOrgContext()
  const { data: bill, error } = await context.supabase.from("vendor_bills").select("id,project_id").eq("org_id",context.orgId).eq("id",z.string().uuid().parse(billId)).single()
  if (error || !bill) throw new Error("Payable not found")
  const { requireAuthorization } = await import("@/lib/services/authorization")
  await requireAuthorization({ permission:"bill.read", userId:context.userId, orgId:context.orgId, projectId:bill.project_id, supabase:context.supabase })
  const service = createServiceSupabaseClient()
  const { data: settings, error: settingsError } = await service.from("books_settings").select("workspace_enabled,arc_ledger_mode").eq("org_id",context.orgId).maybeSingle()
  if (settingsError) throw new Error(settingsError.message)
  if (!settings?.workspace_enabled || settings.arc_ledger_mode === "disabled") return []
  return collectBooksRows((from,to) => service.from("gl_accounts").select("id,code,name,subtype").eq("org_id",context.orgId).eq("active",true).in("subtype",["cash","credit_card"]).order("code").order("id").range(from,to))
}
