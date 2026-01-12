"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Download } from "@/components/icons"

type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string }

function formatCurrency(cents?: number | null) {
  if (typeof cents !== "number") return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "GET" })
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status}`)
  }
  return res.json()
}

export function ProjectReportsClient({ projectId }: { projectId: string }) {
  const [tab, setTab] = useState<"ar" | "ap" | "forecast" | "draws" | "cos">("ar")

  const arAgingUrl = useMemo(() => `/api/projects/${projectId}/reports/ar-aging`, [projectId])
  const apAgingUrl = useMemo(() => `/api/projects/${projectId}/reports/ap-aging`, [projectId])
  const arLedgerUrl = useMemo(() => `/api/projects/${projectId}/reports/payments-ledger?kind=ar`, [projectId])
  const apLedgerUrl = useMemo(() => `/api/projects/${projectId}/reports/payments-ledger?kind=ap`, [projectId])
  const forecastUrl = useMemo(() => `/api/projects/${projectId}/reports/forecast`, [projectId])
  const drawsUrl = useMemo(() => `/api/projects/${projectId}/reports/draws`, [projectId])
  const cosUrl = useMemo(() => `/api/projects/${projectId}/reports/change-orders`, [projectId])

  const [arAging, setArAging] = useState<LoadState<any>>({ status: "idle" })
  const [apAging, setApAging] = useState<LoadState<any>>({ status: "idle" })
  const [arLedger, setArLedger] = useState<LoadState<any>>({ status: "idle" })
  const [apLedger, setApLedger] = useState<LoadState<any>>({ status: "idle" })
  const [forecast, setForecast] = useState<LoadState<any>>({ status: "idle" })
  const [draws, setDraws] = useState<LoadState<any>>({ status: "idle" })
  const [cos, setCos] = useState<LoadState<any>>({ status: "idle" })

  useEffect(() => {
    let cancelled = false

    async function load<T>(url: string, setter: (value: LoadState<T>) => void) {
      setter({ status: "loading" })
      try {
        const data = await fetchJson<T>(url)
        if (cancelled) return
        const errorMessage = (data as any)?.error
        if (errorMessage) {
          setter({ status: "error", error: String(errorMessage) })
          return
        }
        setter({ status: "ready", data })
      } catch (err: any) {
        if (cancelled) return
        setter({ status: "error", error: err?.message ?? "Failed to load" })
      }
    }

    if (tab === "ar") {
      if (arAging.status === "idle") load(arAgingUrl, setArAging)
      if (arLedger.status === "idle") load(arLedgerUrl, setArLedger)
    }

    if (tab === "ap") {
      if (apAging.status === "idle") load(apAgingUrl, setApAging)
      if (apLedger.status === "idle") load(apLedgerUrl, setApLedger)
    }

    if (tab === "forecast" && forecast.status === "idle") load(forecastUrl, setForecast)
    if (tab === "draws" && draws.status === "idle") load(drawsUrl, setDraws)
    if (tab === "cos" && cos.status === "idle") load(cosUrl, setCos)

    return () => {
      cancelled = true
    }
  }, [
    tab,
    arAging.status,
    apAging.status,
    arLedger.status,
    apLedger.status,
    forecast.status,
    draws.status,
    cos.status,
    arAgingUrl,
    apAgingUrl,
    arLedgerUrl,
    apLedgerUrl,
    forecastUrl,
    drawsUrl,
    cosUrl,
  ])

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={(v) => setTab(v as any)}>
        <TabsList>
          <TabsTrigger value="ar">AR</TabsTrigger>
          <TabsTrigger value="ap">AP</TabsTrigger>
          <TabsTrigger value="forecast">Forecast</TabsTrigger>
          <TabsTrigger value="draws">Draws</TabsTrigger>
          <TabsTrigger value="cos">COs</TabsTrigger>
        </TabsList>

        <TabsContent value="ar" className="space-y-4">
          <AgingCard
            title="AR Aging"
            state={arAging}
            csvHref={`${arAgingUrl}?format=csv`}
            columns={[
              { header: "Invoice", cell: (r: any) => r.invoice_number ?? "—" },
              { header: "Customer", cell: (r: any) => r.customer_name ?? "—" },
              { header: "Due", cell: (r: any) => r.due_date ?? "—" },
              { header: "Bucket", cell: (r: any) => r.bucket ?? "—" },
              { header: "Open", cell: (r: any) => formatCurrency(r.open_balance_cents) },
            ]}
            totalsKeys={["current", "1_30", "31_60", "61_90", "90_plus", "no_due_date"]}
          />

          <LedgerCard
            title="Payments Ledger (AR)"
            state={arLedger}
            csvHref={`${arLedgerUrl}&format=csv`}
            kindLabel="ar"
          />
        </TabsContent>

        <TabsContent value="ap" className="space-y-4">
          <AgingCard
            title="AP Aging"
            state={apAging}
            csvHref={`${apAgingUrl}?format=csv`}
            columns={[
              { header: "Bill", cell: (r: any) => r.bill_number ?? "—" },
              { header: "Commitment", cell: (r: any) => r.commitment_title ?? "—" },
              { header: "Due", cell: (r: any) => r.due_date ?? "—" },
              { header: "Bucket", cell: (r: any) => r.bucket ?? "—" },
              { header: "Open", cell: (r: any) => formatCurrency(r.open_balance_cents) },
            ]}
            totalsKeys={["current", "1_30", "31_60", "61_90", "90_plus", "no_due_date"]}
          />

          <LedgerCard
            title="Payments Ledger (AP)"
            state={apLedger}
            csvHref={`${apLedgerUrl}&format=csv`}
            kindLabel="ap"
          />
        </TabsContent>

        <TabsContent value="forecast" className="space-y-4">
          <ForecastCard title="Budget vs Committed vs Actual (CTC)" state={forecast} csvHref={`${forecastUrl}?format=csv`} />
        </TabsContent>

        <TabsContent value="draws" className="space-y-4">
          <SimpleTableCard
            title="Draw Schedule Status"
            state={draws}
            csvHref={`${drawsUrl}?format=csv`}
            columns={[
              { header: "Draw", cell: (r: any) => (r.draw_number != null ? `#${r.draw_number}` : "—") },
              { header: "Title", cell: (r: any) => r.title ?? "—" },
              { header: "Due", cell: (r: any) => r.due_date ?? "—" },
              { header: "Status", cell: (r: any) => r.status ?? "—" },
              { header: "Amount", cell: (r: any) => formatCurrency(r.amount_cents) },
              { header: "Invoice", cell: (r: any) => r.invoice_number ?? "—" },
            ]}
            rowsKey="rows"
          />
        </TabsContent>

        <TabsContent value="cos" className="space-y-4">
          <SimpleTableCard
            title="Change Order Log"
            state={cos}
            csvHref={`${cosUrl}?format=csv`}
            columns={[
              { header: "Title", cell: (r: any) => r.title ?? "—" },
              { header: "Status", cell: (r: any) => r.status ?? "—" },
              { header: "Total", cell: (r: any) => formatCurrency(r.total_cents) },
              { header: "Approved", cell: (r: any) => r.approved_at ?? "—" },
              { header: "Days", cell: (r: any) => (typeof r.days_impact === "number" ? r.days_impact : "—") },
            ]}
            rowsKey="rows"
            footer={
              cos.status === "ready" && cos.data?.totals ? (
                <div className="text-sm text-muted-foreground">
                  Approved {formatCurrency(cos.data.totals.approved_total_cents)} • Pending {formatCurrency(cos.data.totals.pending_total_cents)}
                </div>
              ) : null
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function CardToolbar({ csvHref }: { csvHref: string }) {
  return (
    <Button asChild variant="secondary" size="sm">
      <a href={csvHref}>
        <Download className="mr-2 h-4 w-4" />
        CSV
      </a>
    </Button>
  )
}

function LoadingTable() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-2/3" />
    </div>
  )
}

function AgingCard({
  title,
  state,
  csvHref,
  columns,
  totalsKeys,
}: {
  title: string
  state: LoadState<any>
  csvHref: string
  columns: Array<{ header: string; cell: (row: any) => any }>
  totalsKeys: string[]
}) {
  const totals = state.status === "ready" ? state.data?.totals : null

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardToolbar csvHref={csvHref} />
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === "loading" || state.status === "idle" ? (
          <LoadingTable />
        ) : state.status === "error" ? (
          <div className="text-sm text-destructive">{state.error}</div>
        ) : (
          <>
            {totals ? (
              <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                <span>Open {formatCurrency(totals.total_open_cents)}</span>
                {totalsKeys.map((k) => (
                  <span key={k}>
                    {k}: {formatCurrency(totals[k])}
                  </span>
                ))}
              </div>
            ) : null}
            <SimpleTable rows={state.data?.rows ?? []} columns={columns} />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function LedgerCard({
  title,
  state,
  csvHref,
  kindLabel,
}: {
  title: string
  state: LoadState<any>
  csvHref: string
  kindLabel: "ar" | "ap"
}) {
  return (
    <SimpleTableCard
      title={title}
      state={state}
      csvHref={csvHref}
      rowsKey="rows"
      columns={[
        { header: "Received", cell: (r: any) => (r.received_at ? String(r.received_at).slice(0, 10) : "—") },
        {
          header: kindLabel === "ar" ? "Invoice" : "Bill",
          cell: (r: any) => (kindLabel === "ar" ? r.invoice_number ?? "—" : r.bill_number ?? "—"),
        },
        { header: "Amount", cell: (r: any) => formatCurrency(r.amount_cents) },
        { header: "Method", cell: (r: any) => r.method ?? "—" },
        { header: "Reference", cell: (r: any) => r.reference ?? r.provider_payment_id ?? "—" },
        { header: "Status", cell: (r: any) => r.status ?? "—" },
      ]}
    />
  )
}

function ForecastCard({
  title,
  state,
  csvHref,
}: {
  title: string
  state: LoadState<any>
  csvHref: string
}) {
  return (
    <SimpleTableCard
      title={title}
      state={state}
      csvHref={csvHref}
      rowsKey="rows"
      columns={[
        {
          header: "Cost code",
          cell: (r: any) => (r.cost_code_code ? `${r.cost_code_code} ${r.cost_code_name ?? ""}`.trim() : r.cost_code_name ?? "Uncoded"),
        },
        { header: "Adj budget", cell: (r: any) => formatCurrency(r.adjusted_budget_cents) },
        { header: "Committed", cell: (r: any) => formatCurrency(r.committed_cents) },
        { header: "Actual", cell: (r: any) => formatCurrency(r.actual_cents) },
        { header: "Est rem", cell: (r: any) => formatCurrency(r.estimate_remaining_cents) },
        { header: "Proj final", cell: (r: any) => formatCurrency(r.projected_final_cents) },
        { header: "VAC", cell: (r: any) => formatCurrency(r.variance_at_completion_cents) },
      ]}
    />
  )
}

function SimpleTableCard({
  title,
  state,
  csvHref,
  columns,
  rowsKey,
  footer,
}: {
  title: string
  state: LoadState<any>
  csvHref: string
  columns: Array<{ header: string; cell: (row: any) => any }>
  rowsKey: string
  footer?: ReactNode
}) {
  const rows = state.status === "ready" ? (state.data as any)?.[rowsKey] ?? [] : []

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardToolbar csvHref={csvHref} />
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === "loading" || state.status === "idle" ? (
          <LoadingTable />
        ) : state.status === "error" ? (
          <div className="text-sm text-destructive">{state.error}</div>
        ) : (
          <>
            <SimpleTable rows={rows} columns={columns} />
            {footer}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function SimpleTable({
  rows,
  columns,
}: {
  rows: any[]
  columns: Array<{ header: string; cell: (row: any) => any }>
}) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c.header}>{c.header}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell className="text-sm text-muted-foreground" colSpan={columns.length}>
                No rows.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, idx) => (
              <TableRow key={row.id ?? row.invoice_id ?? row.bill_id ?? row.payment_id ?? row.draw_id ?? row.change_order_id ?? idx}>
                {columns.map((c) => (
                  <TableCell key={c.header}>{c.cell(row)}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  )
}
