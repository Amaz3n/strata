import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

export type AccountingExportKind = "ap" | "job_cost" | "journal"

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function toCsv(headers: string[], rows: unknown[][]) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")
}

async function projectIdsForScope(supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"], orgId: string, mapId?: string | null) {
  if (!mapId) {
    const { data } = await supabase.from("projects").select("id").eq("org_id", orgId)
    return (data ?? []).map((row) => row.id)
  }
  const { data: map, error } = await supabase.from("accounting_entity_map")
    .select("project_id,community_id,division_id").eq("org_id", orgId).eq("id", mapId).maybeSingle()
  if (error || !map) throw new Error(error?.message ?? "Accounting scope not found")
  if (map.project_id) return [map.project_id]
  if (map.community_id) {
    const { data } = await supabase.from("lots").select("project_id").eq("org_id", orgId).eq("community_id", map.community_id).not("project_id", "is", null)
    return (data ?? []).map((row) => row.project_id).filter((id): id is string => Boolean(id))
  }
  let query = supabase.from("projects").select("id").eq("org_id", orgId)
  if (map.division_id) query = query.eq("division_id", map.division_id)
  const { data } = await query
  return (data ?? []).map((row) => row.id)
}

async function projectReferences(supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"], orgId: string, projectIds: string[]) {
  if (projectIds.length === 0) return new Map<string, { name: string; division: string; community: string }>()
  const [{ data: projects }, { data: lots }] = await Promise.all([
    supabase.from("projects").select("id,name,division:divisions(name)").eq("org_id", orgId).in("id", projectIds),
    supabase.from("lots").select("project_id,community:communities(name)").eq("org_id", orgId).in("project_id", projectIds),
  ])
  const communities = new Map((lots ?? []).map((lot) => {
    const community = Array.isArray(lot.community) ? lot.community[0] : lot.community
    return [lot.project_id, community?.name ?? ""]
  }))
  return new Map((projects ?? []).map((project) => {
    const division = Array.isArray(project.division) ? project.division[0] : project.division
    return [project.id, { name: project.name, division: division?.name ?? "", community: communities.get(project.id) ?? "" }]
  }))
}

export async function createAccountingExport(input: { kind: AccountingExportKind; startDate: string; endDate: string; entityMapId?: string | null }) {
  const context = await requireOrgContext()
  await requirePermission("financials.export", context)
  const projectIds = await projectIdsForScope(context.supabase, context.orgId, input.entityMapId)
  const projectRefs = await projectReferences(context.supabase, context.orgId, projectIds)
  let csv: string

  if (input.kind === "ap") {
    const headers = ["row_type","vendor","bill_no","date","due","gl_account","amount_cents","payment_method","payment_reference","project","project_id","community","division"]
    if (projectIds.length === 0) csv = toCsv(headers, [])
    else {
      const [{ data: bills, error }, { data: payments, error: paymentError }] = await Promise.all([
        context.supabase.from("vendor_bills")
          .select("id,project_id,bill_number,bill_date,due_date,total_cents,accounting_coding,company:companies(name),commitment:commitments(company:companies(name))")
          .eq("org_id", context.orgId).in("project_id", projectIds).in("status", ["approved","partial","paid"])
          .gte("bill_date", input.startDate).lte("bill_date", input.endDate).order("bill_date"),
        context.supabase.from("payments")
          .select("id,project_id,bill_id,amount_cents,method,reference,received_at,bill:vendor_bills(bill_number,project_id,company:companies(name))")
          .eq("org_id", context.orgId).in("project_id", projectIds).not("bill_id", "is", null).neq("status", "failed")
          .gte("received_at", `${input.startDate}T00:00:00Z`).lte("received_at", `${input.endDate}T23:59:59Z`).order("received_at"),
      ])
      if (error || paymentError) throw new Error(`Unable to build AP export: ${error?.message ?? paymentError?.message}`)
      const billRows = (bills ?? []).map((bill) => {
        const company = Array.isArray(bill.company) ? bill.company[0] : bill.company
        const commitment = Array.isArray(bill.commitment) ? bill.commitment[0] : bill.commitment
        const commitmentCompany = Array.isArray(commitment?.company) ? commitment.company[0] : commitment?.company
        const coding = bill.accounting_coding as { expense_account?: { id?: string; name?: string } } | null
        const ref = projectRefs.get(bill.project_id)
        return ["bill",company?.name ?? commitmentCompany?.name,bill.bill_number,bill.bill_date,bill.due_date,coding?.expense_account?.name ?? coding?.expense_account?.id,bill.total_cents,"","",ref?.name,bill.project_id,ref?.community,ref?.division]
      })
      const paymentRows = (payments ?? []).map((payment) => {
        const bill = Array.isArray(payment.bill) ? payment.bill[0] : payment.bill
        const company = Array.isArray(bill?.company) ? bill.company[0] : bill?.company
        const projectId = payment.project_id ?? bill?.project_id ?? ""
        const ref = projectRefs.get(projectId)
        return ["payment",company?.name,bill?.bill_number,String(payment.received_at).slice(0,10),"","Accounts payable",-Math.abs(Number(payment.amount_cents ?? 0)),payment.method,payment.reference,ref?.name,projectId,ref?.community,ref?.division]
      })
      csv = toCsv(headers, [...billRows, ...paymentRows])
    }
  } else if (input.kind === "job_cost") {
    const headers = ["project","project_id","community","division","cost_code","period","amount_cents"]
    if (projectIds.length === 0) csv = toCsv(headers, [])
    else {
      const [{ data: expenses, error }, { data: bills, error: billError }] = await Promise.all([
        context.supabase.from("project_expenses")
          .select("project_id,expense_date,amount_cents,tax_cents,cost_code:cost_codes(code,name)")
          .eq("org_id", context.orgId).in("project_id", projectIds).in("status", ["approved","locked"]).gte("expense_date", input.startDate).lte("expense_date", input.endDate),
        context.supabase.from("vendor_bills")
          .select("project_id,bill_date,lines:bill_lines(unit_cost_cents,quantity,cost_code:cost_codes(code,name))")
          .eq("org_id", context.orgId).in("project_id", projectIds).in("status", ["approved","partial","paid"]).gte("bill_date", input.startDate).lte("bill_date", input.endDate),
      ])
      if (error || billError) throw new Error(`Unable to build job-cost export: ${error?.message ?? billError?.message}`)
      const totals = new Map<string, { projectId: string; code: string; period: string; amount: number }>()
      const add = (projectId: string, code: string, date: string, amount: number) => {
        const period = String(date).slice(0, 7)
        const key = `${projectId}:${code}:${period}`
        const current = totals.get(key)
        totals.set(key, { projectId, code, period, amount: (current?.amount ?? 0) + amount })
      }
      for (const expense of expenses ?? []) {
        const code = Array.isArray(expense.cost_code) ? expense.cost_code[0] : expense.cost_code
        add(expense.project_id, [code?.code, code?.name].filter(Boolean).join(" ") || "Uncoded", expense.expense_date, Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0))
      }
      for (const bill of bills ?? []) for (const line of bill.lines ?? []) {
        const code = Array.isArray(line.cost_code) ? line.cost_code[0] : line.cost_code
        add(bill.project_id, [code?.code, code?.name].filter(Boolean).join(" ") || "Uncoded", bill.bill_date, Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1)))
      }
      csv = toCsv(headers, [...totals.values()].map((row) => { const ref = projectRefs.get(row.projectId); return [ref?.name ?? row.projectId,row.projectId,ref?.community,ref?.division,row.code,row.period,row.amount] }))
    }
  } else {
    const headers = ["date","account","dimension","debit_cents","credit_cents","memo","source_type","source_id"]
    if (projectIds.length === 0) csv = toCsv(headers, [])
    else {
      const [{ data: invoices, error }, { data: expenses, error: expenseError }, { data: bills, error: billError }] = await Promise.all([
        context.supabase.from("invoices").select("id,project_id,issue_date,invoice_number,total_cents").eq("org_id", context.orgId).in("project_id", projectIds).gte("issue_date", input.startDate).lte("issue_date", input.endDate).neq("status", "void").order("issue_date"),
        context.supabase.from("project_expenses").select("id,project_id,expense_date,description,amount_cents,tax_cents,accounting_coding").eq("org_id", context.orgId).in("project_id", projectIds).in("status", ["approved","locked"]).gte("expense_date", input.startDate).lte("expense_date", input.endDate),
        context.supabase.from("vendor_bills").select("id,project_id,bill_date,bill_number,total_cents,accounting_coding").eq("org_id", context.orgId).in("project_id", projectIds).in("status", ["approved","partial","paid"]).gte("bill_date", input.startDate).lte("bill_date", input.endDate),
      ])
      if (error || expenseError || billError) throw new Error(`Unable to build journal export: ${error?.message ?? expenseError?.message ?? billError?.message}`)
      const invoiceRows = (invoices ?? []).flatMap((invoice) => {
        const project = projectRefs.get(invoice.project_id)
        const memo = `Invoice ${invoice.invoice_number ?? invoice.id}`
        return [[invoice.issue_date,"Accounts receivable",project?.name ?? invoice.project_id,invoice.total_cents,0,memo,"invoice",invoice.id],[invoice.issue_date,"Revenue",project?.name ?? invoice.project_id,0,invoice.total_cents,memo,"invoice",invoice.id]]
      })
      const expenseRows = [...(expenses ?? []).map((row) => ({ ...row, date: row.expense_date, amount: Number(row.amount_cents ?? 0) + Number(row.tax_cents ?? 0), memo: row.description || `Expense ${row.id}`, source: "expense", credit: "Cash / card" })), ...(bills ?? []).map((row) => ({ ...row, date: row.bill_date, amount: Number(row.total_cents ?? 0), memo: `Bill ${row.bill_number ?? row.id}`, source: "bill", credit: "Accounts payable" }))].flatMap((row) => {
        const project = projectRefs.get(row.project_id)
        const coding = row.accounting_coding as { expense_account?: { name?: string; id?: string } } | null
        const expenseAccount = coding?.expense_account?.name ?? coding?.expense_account?.id ?? "Job cost"
        return [[row.date,expenseAccount,project?.name ?? row.project_id,row.amount,0,row.memo,row.source,row.id],[row.date,row.credit,project?.name ?? row.project_id,0,row.amount,row.memo,row.source,row.id]]
      })
      csv = toCsv(headers, [...invoiceRows, ...expenseRows])
    }
  }

  const exportId = crypto.randomUUID()
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "accounting_export", entityId: exportId, after: { kind: input.kind, start_date: input.startDate, end_date: input.endDate, entity_map_id: input.entityMapId ?? null } }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "accounting_export", entityType: "accounting_export", entityId: exportId, payload: { kind: input.kind, entity_map_id: input.entityMapId ?? null } }),
  ])
  return { filename: `arc-${input.kind}-${input.startDate}-${input.endDate}.csv`, csv }
}
