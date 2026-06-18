import "server-only"

import { randomUUID } from "node:crypto"

import { buildTableArtifact } from "@/lib/services/ai-search/artifacts"
import { retrieveHybridResults } from "@/lib/services/ai-search/retrieval"
import { resolveProjectById, resolveProjectFromHints, type ProjectRef } from "@/lib/services/ai-search/projects"
import type { AiSearchArtifact, AiSearchExportLink } from "@/lib/services/ai-search"
import type { requireOrgContext } from "@/lib/services/context"
import type { SearchResult } from "@/lib/services/search"

type ResolvedOrgContext = Awaited<ReturnType<typeof requireOrgContext>>

const ANALYTICS_BATCH_SIZE = 1_000
const MAX_ANALYTICS_ROWS_SOFT_LIMIT = 100_000
const OPEN_INVOICE_STATUSES = ["sent", "partial", "overdue", "saved", "draft"] as const

export type FinancialRollup = {
  project?: ProjectRef
  invoiceCount: number
  invoiceTotalCents: number
  paymentCount: number
  paymentTotalCents: number
  budgetCount: number
  budgetTotalCents: number
  estimateCount: number
  estimateTotalCents: number
  commitmentCount: number
  commitmentTotalCents: number
  changeOrderCount: number
  changeOrderTotalCents: number
}

type AnalyticsGroupBy = "none" | "status" | "project" | "month" | "aging"

export type CanonicalMetricKey =
  | "revenue_billed"
  | "cash_collected"
  | "open_ar"
  | "overdue_ar"
  | "budget_commitment_gap"

export type CanonicalMetricIntent = {
  key: CanonicalMetricKey
  label: string
  projectName?: string
  dateRangeDays?: number
  groupBy: AnalyticsGroupBy
  limit: number
}

export type CanonicalMetricExecution = {
  summary: string
  metricValue: number
  metricValueCents?: number
  rowCount: number
  relatedResults: SearchResult[]
  additionalContext: string
  artifactData: { artifact?: AiSearchArtifact; exports?: AiSearchExportLink[] }
  confidence: "low" | "medium" | "high"
  missingData: string[]
}

export type DrawPaymentStatusIntent = {
  projectName?: string
  projectId?: string
  drawNumbers: number[]
  includeDeposit: boolean
  limit: number
}

type DrawPaymentStatusRow = {
  label: string
  title: string
  status: string
  amountCents: number
  invoiced: boolean
  invoiceId?: string
  invoiceNumber?: string
  invoiceStatus?: string
  balanceDueCents?: number
  paidCents: number
  paidAt?: string
}

function dedupeResults(results: SearchResult[]) {
  const unique: SearchResult[] = []
  const seen = new Set<string>()

  for (const result of results) {
    const key = `${result.type}:${result.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(result)
  }

  return unique
}

function toStatusLabel(status: string) {
  return status.replace(/_/g, " ")
}

async function sumCentsField({
  context,
  table,
  centsField,
  projectId,
}: {
  context: Awaited<ReturnType<typeof requireOrgContext>>
  table: string
  centsField: string
  projectId?: string
}) {
  let totalCents = 0
  let count = 0
  let offset = 0

  while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
    let queryBuilder = context.supabase
      .from(table)
      .select(centsField)
      .eq("org_id", context.orgId)
      .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)

    if (projectId) {
      queryBuilder = queryBuilder.eq("project_id", projectId)
    }

    const { data, error } = await queryBuilder
    if (error || !Array.isArray(data)) {
      if (error) {
        console.error("Failed to aggregate cents field", { table, centsField, projectId, error })
      }
      return { count: 0, totalCents: 0 }
    }

    if (data.length === 0) break
    count += data.length
    for (const row of data) {
      const value = (row as unknown as Record<string, unknown>)[centsField]
      if (typeof value === "number" && Number.isFinite(value)) {
        totalCents += value
      }
    }

    if (data.length < ANALYTICS_BATCH_SIZE) break
    offset += ANALYTICS_BATCH_SIZE
  }

  return { count, totalCents }
}

export async function loadFinancialRollup({
  context,
  project,
}: {
  context: Awaited<ReturnType<typeof requireOrgContext>>
  project?: ProjectRef
}): Promise<FinancialRollup> {
  const projectId = project?.id
  const [invoices, payments, budgets, estimates, commitments, changeOrders] = await Promise.all([
    sumCentsField({ context, table: "invoices", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "payments", centsField: "amount_cents", projectId }),
    sumCentsField({ context, table: "budgets", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "estimates", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "commitments", centsField: "total_cents", projectId }),
    sumCentsField({ context, table: "change_orders", centsField: "total_cents", projectId }),
  ])

  return {
    project,
    invoiceCount: invoices.count,
    invoiceTotalCents: invoices.totalCents,
    paymentCount: payments.count,
    paymentTotalCents: payments.totalCents,
    budgetCount: budgets.count,
    budgetTotalCents: budgets.totalCents,
    estimateCount: estimates.count,
    estimateTotalCents: estimates.totalCents,
    commitmentCount: commitments.count,
    commitmentTotalCents: commitments.totalCents,
    changeOrderCount: changeOrders.count,
    changeOrderTotalCents: changeOrders.totalCents,
  }
}

function buildCanonicalGroupKey({
  groupBy,
  status,
  projectName,
  createdAt,
}: {
  groupBy: AnalyticsGroupBy
  status?: string | null
  projectName?: string | null
  createdAt?: string | null
}) {
  if (groupBy === "status") {
    return status ? toStatusLabel(status) : "Unknown"
  }
  if (groupBy === "project") {
    return projectName && projectName.trim().length > 0 ? projectName : "No project"
  }
  if (groupBy === "month") {
    if (createdAt) {
      const date = new Date(createdAt)
      if (Number.isFinite(date.getTime())) {
        return `${date.getUTCFullYear()}-${`${date.getUTCMonth() + 1}`.padStart(2, "0")}`
      }
    }
    return "Unknown month"
  }
  return "Total"
}

function incrementCanonicalBuckets(
  bucketMap: Map<string, { label: string; amountCents: number; count: number }>,
  label: string,
  amountCents: number,
) {
  const current = bucketMap.get(label) ?? { label, amountCents: 0, count: 0 }
  current.amountCents += amountCents
  current.count += 1
  bucketMap.set(label, current)
}

function mapInvoiceMetricResult(row: Record<string, unknown>): SearchResult {
  const id = typeof row.id === "string" ? row.id : randomUUID()
  const titleRaw = typeof row.title === "string" ? row.title.trim() : ""
  const invoiceNumber = typeof row.invoice_number === "string" ? row.invoice_number : ""
  const title = titleRaw || invoiceNumber || "Invoice"
  const status = typeof row.status === "string" ? row.status : undefined
  const totalCents = typeof row.total_cents === "number" ? row.total_cents : 0
  const balanceCents = typeof row.balance_due_cents === "number" ? row.balance_due_cents : 0
  const dueDate = typeof row.due_date === "string" ? row.due_date : undefined
  const projects = row.projects && typeof row.projects === "object" ? (row.projects as { name?: string | null }) : undefined

  const subtitle = [status, totalCents > 0 ? formatUsd(totalCents) : null, balanceCents > 0 ? `open ${formatUsd(balanceCents)}` : null, dueDate]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" • ")

  return {
    id,
    type: "invoice",
    title,
    subtitle: subtitle || undefined,
    href: `/invoices/${id}`,
    project_id: typeof row.project_id === "string" ? row.project_id : undefined,
    project_name: typeof projects?.name === "string" ? projects.name : undefined,
    updated_at: typeof row.created_at === "string" ? row.created_at : undefined,
  }
}

function mapPaymentMetricResult(row: Record<string, unknown>): SearchResult {
  const id = typeof row.id === "string" ? row.id : randomUUID()
  const reference = typeof row.reference === "string" ? row.reference.trim() : ""
  const method = typeof row.method === "string" ? row.method : undefined
  const amountCents = typeof row.amount_cents === "number" ? row.amount_cents : 0
  const status = typeof row.status === "string" ? row.status : undefined
  const projects = row.projects && typeof row.projects === "object" ? (row.projects as { name?: string | null }) : undefined

  const subtitle = [status, method, amountCents > 0 ? formatUsd(amountCents) : null]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" • ")

  return {
    id,
    type: "payment",
    title: reference || "Payment",
    subtitle: subtitle || undefined,
    href: `/payments/${id}`,
    project_id: typeof row.project_id === "string" ? row.project_id : undefined,
    project_name: typeof projects?.name === "string" ? projects.name : undefined,
    updated_at: typeof row.created_at === "string" ? row.created_at : undefined,
  }
}

export async function executeDrawPaymentStatusIntent(
  intent: DrawPaymentStatusIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
): Promise<CanonicalMetricExecution> {
  const resolvedProject = intent.projectId
    ? await resolveProjectById(intent.projectId, context)
    : await resolveProjectFromHints(context, intent.projectName)

  if (!resolvedProject) {
    return {
      summary: "Which project should I check? I can answer deposit or draw payment status once I know the project.",
      metricValue: 0,
      metricValueCents: 0,
      rowCount: 0,
      relatedResults: [],
      additionalContext: [
        "Draw payment status execution",
        "Missing project scope",
        intent.projectName ? `Project hint: ${intent.projectName}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      artifactData: {},
      confidence: "low",
      missingData: ["Project scope is required to check deposit or draw payment status."],
    }
  }

  const { data: drawData, error: drawError } = await context.supabase
    .from("draw_schedules")
    .select("id,draw_number,title,status,amount_cents,due_date,paid_at,invoice_id,metadata,created_at")
    .eq("org_id", context.orgId)
    .eq("project_id", resolvedProject.id)
    .order("draw_number", { ascending: true })
    .limit(Math.max(50, intent.limit))

  if (drawError || !Array.isArray(drawData)) {
    console.error("Draw payment status query failed", drawError)
    return {
      summary: `I could not read the draw schedule for ${resolvedProject.name}.`,
      metricValue: 0,
      metricValueCents: 0,
      rowCount: 0,
      relatedResults: [],
      additionalContext: `Draw payment status query failed for project ${resolvedProject.id}`,
      artifactData: {},
      confidence: "low",
      missingData: ["Draw schedule could not be loaded."],
    }
  }

  const requestedNumbers = new Set(intent.drawNumbers)
  const hasSpecificTargets = requestedNumbers.size > 0
  const drawRows = drawData
    .map((row) => row as Record<string, unknown>)
    .filter((row) => {
      const drawNumber = typeof row.draw_number === "number" ? row.draw_number : null
      const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {}
      const isDeposit = drawNumber === 0 || metadata.is_deposit === true
      if (hasSpecificTargets) {
        return (drawNumber !== null && requestedNumbers.has(drawNumber)) || (intent.includeDeposit && isDeposit)
      }
      return true
    })
    .slice(0, intent.limit)

  if (drawRows.length === 0) {
    const targetLabel =
      intent.drawNumbers.length > 0
        ? intent.drawNumbers.map((drawNumber) => (drawNumber === 0 ? "deposit" : `draw ${drawNumber}`)).join(", ")
        : "draw schedule"
    return {
      summary: `I did not find ${targetLabel} for ${resolvedProject.name}.`,
      metricValue: 0,
      metricValueCents: 0,
      rowCount: 0,
      relatedResults: [],
      additionalContext: [
        "Draw payment status execution",
        `Project: ${resolvedProject.name}`,
        `Requested draw numbers: ${intent.drawNumbers.join(",") || "all"}`,
      ].join("\n"),
      artifactData: {},
      confidence: "low",
      missingData: ["No matching draw schedule rows were found."],
    }
  }

  const invoiceIds = Array.from(
    new Set(
      drawRows
        .map((row) => (typeof row.invoice_id === "string" ? row.invoice_id : null))
        .filter((id): id is string => Boolean(id)),
    ),
  )

  const invoicesById = new Map<string, Record<string, unknown>>()
  const paymentsByInvoiceId = new Map<string, Record<string, unknown>[]>()
  const relatedResults: SearchResult[] = []

  if (invoiceIds.length > 0) {
    const { data: invoiceData, error: invoiceError } = await context.supabase
      .from("invoices")
      .select("id,title,invoice_number,status,total_cents,balance_due_cents,due_date,project_id,projects(name),created_at")
      .eq("org_id", context.orgId)
      .in("id", invoiceIds)

    if (!invoiceError && Array.isArray(invoiceData)) {
      for (const invoice of invoiceData) {
        const record = invoice as Record<string, unknown>
        const id = typeof record.id === "string" ? record.id : ""
        if (!id) continue
        invoicesById.set(id, record)
        relatedResults.push(mapInvoiceMetricResult(record))
      }
    }

    const [paymentResult, allocationResult] = await Promise.all([
      context.supabase
        .from("payments")
        .select("id,invoice_id,reference,method,status,amount_cents,project_id,projects(name),received_at,created_at")
        .eq("org_id", context.orgId)
        .in("invoice_id", invoiceIds),
      context.supabase
        .from("payment_allocations")
        .select("id,invoice_id,amount_cents,project_id,payment:payments!inner(id,reference,method,status,received_at,created_at),projects(name)")
        .eq("org_id", context.orgId)
        .in("invoice_id", invoiceIds),
    ])

    if (!paymentResult.error && Array.isArray(paymentResult.data)) {
      for (const payment of paymentResult.data) {
        const record = payment as Record<string, unknown>
        const invoiceId = typeof record.invoice_id === "string" ? record.invoice_id : ""
        if (!invoiceId) continue
        const bucket = paymentsByInvoiceId.get(invoiceId) ?? []
        bucket.push(record)
        paymentsByInvoiceId.set(invoiceId, bucket)
        relatedResults.push(mapPaymentMetricResult(record))
      }
    }
    if (!allocationResult.error && Array.isArray(allocationResult.data)) {
      for (const allocation of allocationResult.data) {
        const row = allocation as Record<string, unknown>
        const payment = Array.isArray(row.payment) ? row.payment[0] : row.payment
        const record = {
          ...(payment && typeof payment === "object" ? payment : {}),
          id: row.id,
          invoice_id: row.invoice_id,
          amount_cents: row.amount_cents,
          project_id: row.project_id,
          projects: row.projects,
        } as Record<string, unknown>
        const invoiceId = typeof record.invoice_id === "string" ? record.invoice_id : ""
        if (!invoiceId) continue
        const bucket = paymentsByInvoiceId.get(invoiceId) ?? []
        bucket.push(record)
        paymentsByInvoiceId.set(invoiceId, bucket)
        relatedResults.push(mapPaymentMetricResult(record))
      }
    }
  }

  const statusRows: DrawPaymentStatusRow[] = drawRows.map((row) => {
    const drawNumber = typeof row.draw_number === "number" ? row.draw_number : null
    const metadata = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {}
    const isDeposit = drawNumber === 0 || metadata.is_deposit === true
    const label = isDeposit ? "Deposit" : drawNumber !== null ? `Draw ${drawNumber}` : "Draw"
    const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : label
    const invoiceId = typeof row.invoice_id === "string" ? row.invoice_id : undefined
    const invoice = invoiceId ? invoicesById.get(invoiceId) : undefined
    const payments = invoiceId ? paymentsByInvoiceId.get(invoiceId) ?? [] : []
    const paidCents = payments.reduce((sum, payment) => {
      const amount = typeof payment.amount_cents === "number" ? payment.amount_cents : 0
      return sum + Math.max(0, amount)
    }, 0)
    const amountCents =
      typeof row.amount_cents === "number"
        ? row.amount_cents
        : invoice && typeof invoice.total_cents === "number"
          ? invoice.total_cents
          : 0
    const balanceDueCents = invoice && typeof invoice.balance_due_cents === "number" ? invoice.balance_due_cents : undefined
    const invoiceStatus = invoice && typeof invoice.status === "string" ? invoice.status : undefined
    const rawStatus = typeof row.status === "string" ? row.status : ""
    const receivedDates = payments
      .map((payment) => (typeof payment.received_at === "string" ? payment.received_at : ""))
      .filter(Boolean)
      .sort()
    const paidAt = typeof row.paid_at === "string" ? row.paid_at : receivedDates[receivedDates.length - 1]

    let status = rawStatus || invoiceStatus || "not invoiced"
    if (rawStatus === "paid" || invoiceStatus === "paid" || (balanceDueCents !== undefined && balanceDueCents <= 0 && invoiceId)) {
      status = "paid"
    } else if (paidCents > 0 || invoiceStatus === "partial") {
      status = "partially paid"
    } else if (!invoiceId) {
      status = "not invoiced"
    } else if (invoiceStatus === "sent" || invoiceStatus === "overdue" || invoiceStatus === "draft" || invoiceStatus === "saved") {
      status = "unpaid"
    }

    return {
      label,
      title,
      status,
      amountCents,
      invoiced: Boolean(invoiceId),
      invoiceId,
      invoiceNumber: invoice && typeof invoice.invoice_number === "string" ? invoice.invoice_number : undefined,
      invoiceStatus,
      balanceDueCents,
      paidCents,
      paidAt,
    }
  })

  const paidCount = statusRows.filter((row) => row.status === "paid").length
  const partialCount = statusRows.filter((row) => row.status === "partially paid").length
  const targetSummary = statusRows
    .slice(0, 5)
    .map((row) => {
      const invoicePart = row.invoiceNumber ? `, invoice ${row.invoiceNumber}` : row.invoiced ? ", linked invoice" : ", no invoice yet"
      const balancePart =
        row.balanceDueCents !== undefined && row.balanceDueCents > 0 ? `, balance due ${formatUsd(row.balanceDueCents)}` : ""
      const paidPart = row.paidAt ? `, paid ${row.paidAt.slice(0, 10)}` : row.paidCents > 0 ? `, received ${formatUsd(row.paidCents)}` : ""
      return `${row.label} is ${row.status}${invoicePart}${balancePart}${paidPart}`
    })
    .join("; ")

  const artifactData =
    buildTableArtifact({
      orgId: context.orgId,
      title: `Draw payment status - ${resolvedProject.name}`,
      columns: ["Draw", "Title", "Status", "Amount (USD)", "Paid (USD)", "Balance Due (USD)", "Invoice"],
      rows: statusRows.map((row) => [
        row.label,
        row.title,
        row.status,
        Number((row.amountCents / 100).toFixed(2)),
        Number((row.paidCents / 100).toFixed(2)),
        row.balanceDueCents === undefined ? null : Number((row.balanceDueCents / 100).toFixed(2)),
        row.invoiceNumber ?? (row.invoiced ? "Linked" : "Not invoiced"),
      ]),
    }) ?? {}

  return {
    summary: `${targetSummary}. (${paidCount} paid, ${partialCount} partially paid, ${statusRows.length - paidCount - partialCount} not fully paid) for ${resolvedProject.name}.`,
    metricValue: paidCount,
    metricValueCents: statusRows.reduce((sum, row) => sum + row.paidCents, 0),
    rowCount: statusRows.length,
    relatedResults: dedupeResults(relatedResults).slice(0, Math.max(8, Math.min(intent.limit, 16))),
    additionalContext: [
      "Draw payment status execution",
      `Project: ${resolvedProject.name}`,
      `Rows: ${statusRows.length}`,
      ...statusRows.map(
        (row) =>
          `${row.label}: status=${row.status}; amount_cents=${row.amountCents}; paid_cents=${row.paidCents}; balance_due_cents=${row.balanceDueCents ?? "unknown"}; invoice=${row.invoiceNumber ?? row.invoiceId ?? "none"}`,
      ),
    ].join("\n"),
    artifactData,
    confidence: "high",
    missingData: statusRows.some((row) => !row.invoiced) ? ["One or more matching draws do not have a linked invoice yet."] : [],
  }
}

export async function executeCanonicalMetricIntent(
  intent: CanonicalMetricIntent,
  context: Awaited<ReturnType<typeof requireOrgContext>>,
  options: { enableHybridRetrieval?: boolean } = {},
): Promise<CanonicalMetricExecution> {
  const enableHybridRetrieval = options.enableHybridRetrieval === true
  const resolvedProject = await resolveProjectFromHints(context, intent.projectName)
  const bucketMap = new Map<string, { label: string; amountCents: number; count: number }>()
  const relatedResults: SearchResult[] = []

  const addResult = (result: SearchResult) => {
    if (relatedResults.length >= Math.max(8, Math.min(intent.limit, 16))) return
    relatedResults.push(result)
  }

  const sinceIso = intent.dateRangeDays
    ? new Date(Date.now() - intent.dateRangeDays * 24 * 60 * 60 * 1000).toISOString()
    : undefined
  const todayIso = new Date().toISOString().slice(0, 10)

  if (intent.key === "budget_commitment_gap") {
    const rollup = await loadFinancialRollup({ context, project: resolvedProject ?? undefined })
    const gapCents = rollup.budgetTotalCents - rollup.commitmentTotalCents

    const fallbackRelated = await retrieveHybridResults({
      context,
      query: resolvedProject?.name ?? "budget commitments",
      entityTypes: ["budget", "commitment", "project"],
      filters: resolvedProject?.id ? { projectId: resolvedProject.id } : {},
      limit: Math.max(8, Math.min(intent.limit, 12)),
      enableHybrid: enableHybridRetrieval,
    })
    const dedupedRelated = dedupeResults(fallbackRelated).slice(0, Math.max(8, Math.min(intent.limit, 12)))

    const artifactData =
      buildTableArtifact({
        orgId: context.orgId,
        title: resolvedProject?.name ? `Budget vs commitments - ${resolvedProject.name}` : "Budget vs commitments",
        columns: ["Scope", "Budget (USD)", "Commitments (USD)", "Gap (USD)"],
        rows: [
          [
            resolvedProject?.name ?? "Org-wide",
            Number((rollup.budgetTotalCents / 100).toFixed(2)),
            Number((rollup.commitmentTotalCents / 100).toFixed(2)),
            Number((gapCents / 100).toFixed(2)),
          ],
        ],
      }) ?? {}

    return {
      summary: `Budget is ${formatUsd(rollup.budgetTotalCents)} and commitments are ${formatUsd(rollup.commitmentTotalCents)}${
        resolvedProject?.name ? ` for ${resolvedProject.name}` : ""
      }. Gap is ${formatUsd(gapCents)}.`,
      metricValue: gapCents / 100,
      metricValueCents: gapCents,
      rowCount: rollup.budgetCount + rollup.commitmentCount,
      relatedResults: dedupedRelated,
      additionalContext: [
        "Canonical metric execution",
        `Metric: ${intent.key}`,
        `Scope: ${resolvedProject?.name ?? "org-wide"}`,
        `Budget total cents: ${rollup.budgetTotalCents}`,
        `Commitment total cents: ${rollup.commitmentTotalCents}`,
        `Gap cents: ${gapCents}`,
      ].join("\n"),
      artifactData,
      confidence: "high",
      missingData: [],
    }
  }

  if (intent.key === "cash_collected") {
    let totalCents = 0
    let rowCount = 0
    let offset = 0

    while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
      let queryBuilder = context.supabase
        .from("payments")
        .select("id,reference,method,status,amount_cents,project_id,projects(name),created_at")
        .eq("org_id", context.orgId)
        .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)
        .order("created_at", { ascending: false })

      if (resolvedProject?.id) {
        queryBuilder = queryBuilder.eq("project_id", resolvedProject.id)
      }
      if (sinceIso) {
        queryBuilder = queryBuilder.gte("created_at", sinceIso)
      }

      const { data, error } = await queryBuilder
      if (error) {
        console.error("Canonical cash_collected query failed", error)
        break
      }

      const batch = Array.isArray(data) ? data : []
      if (batch.length === 0) break

      for (const row of batch) {
        const record = row as Record<string, unknown>
        const amountCents = typeof record.amount_cents === "number" ? record.amount_cents : 0
        totalCents += amountCents
        rowCount += 1
        addResult(mapPaymentMetricResult(record))
        incrementCanonicalBuckets(
          bucketMap,
          buildCanonicalGroupKey({
            groupBy: intent.groupBy,
            status: typeof record.status === "string" ? record.status : null,
            projectName:
              record.projects && typeof record.projects === "object"
                ? ((record.projects as { name?: string | null }).name ?? null)
                : null,
            createdAt: typeof record.created_at === "string" ? record.created_at : null,
          }),
          amountCents,
        )
      }

      if (batch.length < ANALYTICS_BATCH_SIZE) break
      offset += ANALYTICS_BATCH_SIZE
    }

    const buckets = Array.from(bucketMap.values())
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 12)
    const artifactData =
      buckets.length > 0
        ? buildTableArtifact({
            orgId: context.orgId,
            title: `Cash collected${resolvedProject?.name ? ` - ${resolvedProject.name}` : ""}`,
            columns: ["Group", "Amount (USD)", "Records"],
            rows: buckets.map((bucket) => [bucket.label, Number((bucket.amountCents / 100).toFixed(2)), bucket.count]),
          }) ?? {}
        : {}

    return {
      summary: `Cash collected is ${formatUsd(totalCents)}${resolvedProject?.name ? ` for ${resolvedProject.name}` : ""}${
        intent.dateRangeDays ? ` in the last ${intent.dateRangeDays} days` : ""
      }.`,
      metricValue: totalCents / 100,
      metricValueCents: totalCents,
      rowCount,
      relatedResults: dedupeResults(relatedResults),
      additionalContext: [
        "Canonical metric execution",
        `Metric: ${intent.key}`,
        `Rows: ${rowCount}`,
        `Total cents: ${totalCents}`,
        `GroupBy: ${intent.groupBy}`,
      ].join("\n"),
      artifactData,
      confidence: rowCount > 0 ? "high" : "low",
      missingData: rowCount > 0 ? [] : ["No payment records matched the requested scope."],
    }
  }

  let totalCents = 0
  let rowCount = 0
  let offset = 0
  while (offset < MAX_ANALYTICS_ROWS_SOFT_LIMIT) {
    let queryBuilder = context.supabase
      .from("invoices")
      .select("id,title,invoice_number,status,total_cents,balance_due_cents,due_date,project_id,projects(name),created_at")
      .eq("org_id", context.orgId)
      .range(offset, offset + ANALYTICS_BATCH_SIZE - 1)
      .order("created_at", { ascending: false })

    if (resolvedProject?.id) {
      queryBuilder = queryBuilder.eq("project_id", resolvedProject.id)
    }
    if (sinceIso) {
      queryBuilder = queryBuilder.gte("created_at", sinceIso)
    }
    if (intent.key === "open_ar" || intent.key === "overdue_ar") {
      queryBuilder = queryBuilder.in("status", [...OPEN_INVOICE_STATUSES]).gt("balance_due_cents", 0)
    }
    if (intent.key === "overdue_ar") {
      queryBuilder = queryBuilder.lt("due_date", todayIso)
    }

    const { data, error } = await queryBuilder
    if (error) {
      console.error("Canonical invoice metric query failed", error)
      break
    }
    const batch = Array.isArray(data) ? data : []
    if (batch.length === 0) break

    for (const row of batch) {
      const record = row as Record<string, unknown>
      const metricCents =
        intent.key === "revenue_billed"
          ? typeof record.total_cents === "number"
            ? record.total_cents
            : 0
          : typeof record.balance_due_cents === "number"
            ? record.balance_due_cents
            : 0
      totalCents += metricCents
      rowCount += 1
      addResult(mapInvoiceMetricResult(record))
      incrementCanonicalBuckets(
        bucketMap,
        buildCanonicalGroupKey({
          groupBy: intent.groupBy,
          status: typeof record.status === "string" ? record.status : null,
          projectName:
            record.projects && typeof record.projects === "object"
              ? ((record.projects as { name?: string | null }).name ?? null)
              : null,
          createdAt: typeof record.created_at === "string" ? record.created_at : null,
        }),
        metricCents,
      )
    }

    if (batch.length < ANALYTICS_BATCH_SIZE) break
    offset += ANALYTICS_BATCH_SIZE
  }

  const bucketRows = Array.from(bucketMap.values())
    .sort((a, b) => b.amountCents - a.amountCents)
    .slice(0, 12)
  const artifactData =
    bucketRows.length > 0
      ? buildTableArtifact({
          orgId: context.orgId,
          title: `${intent.label}${resolvedProject?.name ? ` - ${resolvedProject.name}` : ""}`,
          columns: ["Group", "Amount (USD)", "Records"],
          rows: bucketRows.map((bucket) => [bucket.label, Number((bucket.amountCents / 100).toFixed(2)), bucket.count]),
        }) ?? {}
      : {}

  const label = intent.key === "revenue_billed" ? "Revenue billed" : intent.key === "open_ar" ? "Open AR" : "Overdue AR"
  return {
    summary: `${label} is ${formatUsd(totalCents)}${resolvedProject?.name ? ` for ${resolvedProject.name}` : ""}${
      intent.dateRangeDays ? ` in the last ${intent.dateRangeDays} days` : ""
    }.`,
    metricValue: totalCents / 100,
    metricValueCents: totalCents,
    rowCount,
    relatedResults: dedupeResults(relatedResults),
    additionalContext: [
      "Canonical metric execution",
      `Metric: ${intent.key}`,
      `Rows: ${rowCount}`,
      `Total cents: ${totalCents}`,
      `GroupBy: ${intent.groupBy}`,
    ].join("\n"),
    artifactData,
    confidence: rowCount > 0 ? "high" : "low",
    missingData: rowCount > 0 ? [] : ["No invoice records matched the requested scope."],
  }
}

function formatUsd(cents: number) {
  return `$${(cents / 100).toLocaleString()}`
}

export function formatFinancialRollupContext(rollup: FinancialRollup) {
  const scopeLabel = rollup.project?.name ? `Project: ${rollup.project.name}` : "Scope: org-wide"
  return [
    scopeLabel,
    `Invoices: ${rollup.invoiceCount} totaling ${formatUsd(rollup.invoiceTotalCents)}`,
    `Payments: ${rollup.paymentCount} totaling ${formatUsd(rollup.paymentTotalCents)}`,
    `Budgets: ${rollup.budgetCount} totaling ${formatUsd(rollup.budgetTotalCents)}`,
    `Estimates: ${rollup.estimateCount} totaling ${formatUsd(rollup.estimateTotalCents)}`,
    `Commitments: ${rollup.commitmentCount} totaling ${formatUsd(rollup.commitmentTotalCents)}`,
    `Change orders: ${rollup.changeOrderCount} totaling ${formatUsd(rollup.changeOrderTotalCents)}`,
  ].join("\n")
}

export function buildAnalysisFallbackAnswer({
  query,
  project,
  financialRollup,
  relatedResults,
}: {
  query: string
  project?: ProjectRef | null
  financialRollup?: FinancialRollup | null
  relatedResults: SearchResult[]
}) {
  if (financialRollup) {
    const scope = project?.name ? `for ${project.name}` : "across your org"
    const topMatches = relatedResults
      .slice(0, 3)
      .map((item) => item.title)
      .join(", ")
    const matchLine = topMatches ? ` Top related records: ${topMatches}.` : ""

    return `I pulled financial records ${scope}. Invoices: ${formatUsd(financialRollup.invoiceTotalCents)} (${financialRollup.invoiceCount}), Payments: ${formatUsd(financialRollup.paymentTotalCents)} (${financialRollup.paymentCount}), Budgets: ${formatUsd(financialRollup.budgetTotalCents)} (${financialRollup.budgetCount}), Estimates: ${formatUsd(financialRollup.estimateTotalCents)} (${financialRollup.estimateCount}), Commitments: ${formatUsd(financialRollup.commitmentTotalCents)} (${financialRollup.commitmentCount}), Change orders: ${formatUsd(financialRollup.changeOrderTotalCents)} (${financialRollup.changeOrderCount}).${matchLine}`
  }

  if (relatedResults.length > 0) {
    return `I found ${relatedResults.length} relevant records for "${query}".`
  }

  if (project?.name) {
    return `I found project "${project.name}" but no matching records for that question yet.`
  }

  return `I couldn't find matching records for "${query}" in your org context.`
}
