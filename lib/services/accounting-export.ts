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
  const { data: map, error } = await supabase.from("accounting_entity_map").select("project_id,community_id,division_id").eq("org_id", orgId).eq("id", mapId).maybeSingle()
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
  const communities = new Map(
    (lots ?? []).map((lot) => {
      const community = Array.isArray(lot.community) ? lot.community[0] : lot.community
      return [lot.project_id, community?.name ?? ""]
    }),
  )
  return new Map(
    (projects ?? []).map((project) => {
      const division = Array.isArray(project.division) ? project.division[0] : project.division
      return [project.id, { name: project.name, division: division?.name ?? "", community: communities.get(project.id) ?? "" }]
    }),
  )
}

export async function createAccountingExport(input: { kind: AccountingExportKind; startDate: string; endDate: string; entityMapId?: string | null }) {
  const context = await requireOrgContext()
  await requirePermission("financials.export", context)
  const projectIds = await projectIdsForScope(context.supabase, context.orgId, input.entityMapId)
  const projectRefs = await projectReferences(context.supabase, context.orgId, projectIds)
  let csv: string

  if (input.kind === "ap") {
    const headers = [
      "row_type",
      "vendor",
      "bill_no",
      "date",
      "due",
      "gl_account",
      "amount_cents",
      "payment_method",
      "payment_reference",
      "project",
      "project_id",
      "community",
      "division",
    ]
    if (projectIds.length === 0) csv = toCsv(headers, [])
    else {
      const [{ data: bills, error }, { data: payments, error: paymentError }] = await Promise.all([
        context.supabase
          .from("vendor_bills")
          .select("id,project_id,bill_number,bill_date,due_date,total_cents,accounting_coding,company:companies(name),commitment:commitments(company:companies(name))")
          .eq("org_id", context.orgId)
          .in("project_id", projectIds)
          .in("status", ["approved", "partial", "paid"])
          .gte("bill_date", input.startDate)
          .lte("bill_date", input.endDate)
          .order("bill_date"),
        context.supabase
          .from("payments")
          .select("id,project_id,bill_id,amount_cents,method,reference,received_at,bill:vendor_bills(bill_number,project_id,company:companies(name))")
          .eq("org_id", context.orgId)
          .in("project_id", projectIds)
          .not("bill_id", "is", null)
          .neq("status", "failed")
          .gte("received_at", `${input.startDate}T00:00:00Z`)
          .lte("received_at", `${input.endDate}T23:59:59Z`)
          .order("received_at"),
      ])
      if (error || paymentError) throw new Error(`Unable to build AP export: ${error?.message ?? paymentError?.message}`)
      const billRows = (bills ?? []).map((bill) => {
        const company = Array.isArray(bill.company) ? bill.company[0] : bill.company
        const commitment = Array.isArray(bill.commitment) ? bill.commitment[0] : bill.commitment
        const commitmentCompany = Array.isArray(commitment?.company) ? commitment.company[0] : commitment?.company
        const coding = bill.accounting_coding as { expense_account?: { id?: string; name?: string } } | null
        const ref = projectRefs.get(bill.project_id)
        return [
          "bill",
          company?.name ?? commitmentCompany?.name,
          bill.bill_number,
          bill.bill_date,
          bill.due_date,
          coding?.expense_account?.name ?? coding?.expense_account?.id,
          bill.total_cents,
          "",
          "",
          ref?.name,
          bill.project_id,
          ref?.community,
          ref?.division,
        ]
      })
      const paymentRows = (payments ?? []).map((payment) => {
        const bill = Array.isArray(payment.bill) ? payment.bill[0] : payment.bill
        const company = Array.isArray(bill?.company) ? bill.company[0] : bill?.company
        const projectId = payment.project_id ?? bill?.project_id ?? ""
        const ref = projectRefs.get(projectId)
        return [
          "payment",
          company?.name,
          bill?.bill_number,
          String(payment.received_at).slice(0, 10),
          "",
          "Accounts payable",
          -Math.abs(Number(payment.amount_cents ?? 0)),
          payment.method,
          payment.reference,
          ref?.name,
          projectId,
          ref?.community,
          ref?.division,
        ]
      })
      csv = toCsv(headers, [...billRows, ...paymentRows])
    }
  } else if (input.kind === "job_cost") {
    const headers = ["project", "project_id", "community", "division", "cost_code", "period", "amount_cents"]
    if (projectIds.length === 0) csv = toCsv(headers, [])
    else {
      const [{ data: expenses, error }, { data: bills, error: billError }] = await Promise.all([
        context.supabase
          .from("project_expenses")
          .select("project_id,expense_date,amount_cents,tax_cents,cost_code:cost_codes(code,name)")
          .eq("org_id", context.orgId)
          .in("project_id", projectIds)
          .in("status", ["approved", "locked"])
          .gte("expense_date", input.startDate)
          .lte("expense_date", input.endDate),
        context.supabase
          .from("vendor_bills")
          .select("project_id,bill_date,lines:bill_lines(unit_cost_cents,quantity,cost_code:cost_codes(code,name))")
          .eq("org_id", context.orgId)
          .in("project_id", projectIds)
          .in("status", ["approved", "partial", "paid"])
          .gte("bill_date", input.startDate)
          .lte("bill_date", input.endDate),
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
        add(
          expense.project_id,
          [code?.code, code?.name].filter(Boolean).join(" ") || "Uncoded",
          expense.expense_date,
          Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0),
        )
      }
      for (const bill of bills ?? [])
        for (const line of bill.lines ?? []) {
          const code = Array.isArray(line.cost_code) ? line.cost_code[0] : line.cost_code
          add(
            bill.project_id,
            [code?.code, code?.name].filter(Boolean).join(" ") || "Uncoded",
            bill.bill_date,
            Math.round(Number(line.unit_cost_cents ?? 0) * Number(line.quantity ?? 1)),
          )
        }
      csv = toCsv(
        headers,
        [...totals.values()].map((row) => {
          const ref = projectRefs.get(row.projectId)
          return [ref?.name ?? row.projectId, row.projectId, ref?.community, ref?.division, row.code, row.period, row.amount]
        }),
      )
    }
  } else {
    const headers = ["date", "account", "dimension", "debit_cents", "credit_cents", "memo", "source_type", "source_id"]
    if (projectIds.length === 0) csv = toCsv(headers, [])
    else {
      const [{ data: invoices, error }, { data: expenses, error: expenseError }, { data: bills, error: billError }] = await Promise.all([
        context.supabase
          .from("invoices")
          .select("id,project_id,issue_date,invoice_number,total_cents")
          .eq("org_id", context.orgId)
          .in("project_id", projectIds)
          .gte("issue_date", input.startDate)
          .lte("issue_date", input.endDate)
          .neq("status", "void")
          .order("issue_date"),
        context.supabase
          .from("project_expenses")
          .select("id,project_id,expense_date,description,amount_cents,tax_cents,accounting_coding")
          .eq("org_id", context.orgId)
          .in("project_id", projectIds)
          .in("status", ["approved", "locked"])
          .gte("expense_date", input.startDate)
          .lte("expense_date", input.endDate),
        context.supabase
          .from("vendor_bills")
          .select("id,project_id,bill_date,bill_number,total_cents,accounting_coding")
          .eq("org_id", context.orgId)
          .in("project_id", projectIds)
          .in("status", ["approved", "partial", "paid"])
          .gte("bill_date", input.startDate)
          .lte("bill_date", input.endDate),
      ])
      if (error || expenseError || billError) throw new Error(`Unable to build journal export: ${error?.message ?? expenseError?.message ?? billError?.message}`)
      const invoiceRows = (invoices ?? []).flatMap((invoice) => {
        const project = projectRefs.get(invoice.project_id)
        const memo = `Invoice ${invoice.invoice_number ?? invoice.id}`
        return [
          [invoice.issue_date, "Accounts receivable", project?.name ?? invoice.project_id, invoice.total_cents, 0, memo, "invoice", invoice.id],
          [invoice.issue_date, "Revenue", project?.name ?? invoice.project_id, 0, invoice.total_cents, memo, "invoice", invoice.id],
        ]
      })
      const expenseRows = [
        ...(expenses ?? []).map((row) => ({
          ...row,
          date: row.expense_date,
          amount: Number(row.amount_cents ?? 0) + Number(row.tax_cents ?? 0),
          memo: row.description || `Expense ${row.id}`,
          source: "expense",
          credit: "Cash / card",
        })),
        ...(bills ?? []).map((row) => ({
          ...row,
          date: row.bill_date,
          amount: Number(row.total_cents ?? 0),
          memo: `Bill ${row.bill_number ?? row.id}`,
          source: "bill",
          credit: "Accounts payable",
        })),
      ].flatMap((row) => {
        const project = projectRefs.get(row.project_id)
        const coding = row.accounting_coding as { expense_account?: { name?: string; id?: string } } | null
        const expenseAccount = coding?.expense_account?.name ?? coding?.expense_account?.id ?? "Job cost"
        return [
          [row.date, expenseAccount, project?.name ?? row.project_id, row.amount, 0, row.memo, row.source, row.id],
          [row.date, row.credit, project?.name ?? row.project_id, 0, row.amount, row.memo, row.source, row.id],
        ]
      })
      csv = toCsv(headers, [...invoiceRows, ...expenseRows])
    }
  }

  const exportId = crypto.randomUUID()
  await Promise.all([
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "accounting_export",
      entityId: exportId,
      after: { kind: input.kind, start_date: input.startDate, end_date: input.endDate, entity_map_id: input.entityMapId ?? null },
    }),
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "accounting_export",
      entityType: "accounting_export",
      entityId: exportId,
      payload: { kind: input.kind, entity_map_id: input.entityMapId ?? null },
    }),
  ])
  return { filename: `arc-${input.kind}-${input.startDate}-${input.endDate}.csv`, csv }
}

export type PocJournalReviewRow = {
  key: string
  date: string
  account: string
  dimension: string
  debitCents: number
  creditCents: number
  memo: string
  sourceType: "poc_snapshot"
  sourceId: string
  inputsHash: string
}

async function buildPocJournalReview(context: Awaited<ReturnType<typeof requireOrgContext>>, input: { asOf: string }) {
  const { data, error } = await context.supabase
    .from("poc_snapshots")
    .select("id, project_id, as_of, over_under_cents, inputs_hash, project:projects(name)")
    .eq("org_id", context.orgId)
    .lte("as_of", input.asOf)
    .order("project_id")
    .order("as_of", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10000)
  if (error) throw new Error(`Unable to build the POC journal export: ${error.message}`)

  const monthStart = `${input.asOf.slice(0, 7)}-01`
  type PocSnapshot = NonNullable<typeof data>[number]
  const snapshotsByProject = new Map<string, { current?: PocSnapshot; prior?: PocSnapshot }>()
  for (const row of data ?? []) {
    const snapshots = snapshotsByProject.get(row.project_id) ?? {}
    if (!snapshots.current) snapshots.current = row
    if (!snapshots.prior && row.as_of < monthStart) snapshots.prior = row
    snapshotsByProject.set(row.project_id, snapshots)
  }
  const rows: PocJournalReviewRow[] = []
  for (const [projectId, snapshots] of snapshotsByProject) {
    const current = snapshots.current
    // A monthly true-up must be anchored by a snapshot from the requested month.
    // Otherwise a quiet project would replay an older month's adjustment.
    if (!current || current.as_of < monthStart) continue
    const prior = snapshots.prior
    const currentPosition = -Number(current.over_under_cents ?? 0)
    const priorPosition = -Number(prior?.over_under_cents ?? 0)
    const contractAssetDelta = Math.max(currentPosition, 0) - Math.max(priorPosition, 0)
    const contractLiabilityDelta = Math.max(-currentPosition, 0) - Math.max(-priorPosition, 0)
    if (contractAssetDelta === 0 && contractLiabilityDelta === 0) continue
    const project = Array.isArray(current.project) ? current.project[0] : current.project
    const description = `POC true-up · ${project?.name ?? projectId}`
    const pushPair = (debitAccount: string, creditAccount: string, amount: number) => {
      const common = {
        date: input.asOf,
        dimension: project?.name ?? projectId,
        memo: description,
        sourceType: "poc_snapshot" as const,
        sourceId: current.id,
        inputsHash: current.inputs_hash,
      }
      rows.push({ ...common, key: `${current.id}:${rows.length + 1}`, account: debitAccount, debitCents: amount, creditCents: 0 })
      rows.push({ ...common, key: `${current.id}:${rows.length + 1}`, account: creditAccount, debitCents: 0, creditCents: amount })
    }
    if (contractAssetDelta > 0) pushPair("1150 Contract assets / costs in excess", "4000 Construction revenue", contractAssetDelta)
    if (contractAssetDelta < 0) pushPair("4000 Construction revenue", "1150 Contract assets / costs in excess", Math.abs(contractAssetDelta))
    if (contractLiabilityDelta > 0) pushPair("4000 Construction revenue", "2350 Contract liabilities / billings in excess", contractLiabilityDelta)
    if (contractLiabilityDelta < 0) pushPair("2350 Contract liabilities / billings in excess", "4000 Construction revenue", Math.abs(contractLiabilityDelta))
  }
  return { asOf: input.asOf, rows }
}

/** Read-only report source. The catalog renders this same result to screen, CSV, and PDF. */
export async function getPocJournalReview(input: { asOf: string }) {
  const context = await requireOrgContext()
  await requirePermission("books.read", context)
  return buildPocJournalReview(context, input)
}

/** Review-only monthly POC journal. It never posts or pushes to a provider. */
export async function createPocJournalExport(input: { asOf: string }) {
  const context = await requireOrgContext()
  await requirePermission("financials.export", context)
  const review = await buildPocJournalReview(context, input)
  const csv = toCsv(
    ["date", "account", "dimension", "debit_cents", "credit_cents", "memo", "source_type", "source_id", "inputs_hash"],
    review.rows.map((row) => [row.date, row.account, row.dimension, row.debitCents, row.creditCents, row.memo, row.sourceType, row.sourceId, row.inputsHash]),
  )
  const exportId = crypto.randomUUID()
  await Promise.all([
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "accounting_export",
      entityId: exportId,
      after: { kind: "poc_journal", as_of: input.asOf, row_count: review.rows.length },
    }),
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "accounting_export",
      entityType: "accounting_export",
      entityId: exportId,
      payload: { kind: "poc_journal", as_of: input.asOf, review_only: true },
    }),
  ])
  return { filename: `arc-poc-journal-${input.asOf}.csv`, csv, rowCount: review.rows.length }
}
