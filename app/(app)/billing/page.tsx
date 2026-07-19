import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ArrowUpRight, Download } from "@/components/icons"
import { loadOrgBillingDeskData } from "@/lib/services/org-billing-desk"
import { getOrgWipOverUnderReport, type WipOverUnderRow } from "@/lib/services/reports/wip-over-under"
import { cn } from "@/lib/utils"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"

export const dynamic = "force-dynamic"

const MODEL_LABELS: Record<string, string> = {
  fixed_price: "Fixed price",
  cost_plus_percent: "Cost plus %",
  cost_plus_fixed_fee: "Cost plus fee",
  cost_plus_gmp: "GMP",
  time_and_materials: "T&M",
}

const AGE_SWATCH = {
  fresh: "var(--age-0)",
  aging: "var(--age-1)",
  stale: "var(--age-2)",
} as const

// Give the outer columns breathing room from the card border so they line up
// with the section header (px-4) instead of hugging the edge.
const TABLE_EDGE =
  "[&_th:first-child]:pl-4 [&_td:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4"

function money(cents: number, opts?: { signed?: boolean }) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    signDisplay: opts?.signed ? "always" : "auto",
  })
}

const DAY_MS = 86_400_000

function daysUntilDue(value: string | null): number | null {
  if (!value) return null
  const due = new Date(`${value}T00:00:00`)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - today.getTime()) / DAY_MS)
}

function dueLabel(value: string | null): { text: string; className: string } {
  const days = daysUntilDue(value)
  if (days === null) return { text: "No due date", className: "text-muted-foreground" }
  if (days < 0) return { text: `${-days}d overdue`, className: "font-medium text-[var(--age-2)]" }
  if (days === 0) return { text: "Due today", className: "font-medium text-[var(--age-1)]" }
  const formatted = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(`${value}T00:00:00`),
  )
  return { text: `Due ${formatted}`, className: "text-muted-foreground" }
}

const INVOICE_STATUS: Record<string, { label: string; dotClass: string }> = {
  sent: { label: "Sent", dotClass: "bg-[var(--age-0)]" },
  partial: { label: "Partial", dotClass: "bg-[var(--age-1)]" },
  overdue: { label: "Overdue", dotClass: "bg-[var(--age-2)]" },
}

/** The Aging Spectrum — the page signature. Fresh → aging → stale strata. */
function Spectrum({
  fresh,
  aging,
  stale,
  className,
  hero,
}: {
  fresh: number
  aging: number
  stale: number
  className?: string
  hero?: boolean
}) {
  const total = fresh + aging + stale
  return (
    <div className={cn("spectrum", hero && "spectrum-wipe", className)}>
      {total <= 0
        ? null
        : (
          <>
            {fresh > 0 ? (
              <span style={{ width: `${(fresh / total) * 100}%`, background: AGE_SWATCH.fresh }} />
            ) : null}
            {aging > 0 ? (
              <span style={{ width: `${(aging / total) * 100}%`, background: AGE_SWATCH.aging }} />
            ) : null}
            {stale > 0 ? (
              <span style={{ width: `${(stale / total) * 100}%`, background: AGE_SWATCH.stale }} />
            ) : null}
          </>
        )}
    </div>
  )
}

function Eyebrow({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("microlabel", className)}>{children}</div>
}

/** One figure in a hero segment. All figures share one size for a symmetric row. */
function CompactStat({
  label,
  value,
  sub,
  valueClassName,
  className,
}: {
  label: string
  value: string
  sub: string
  valueClassName?: string
  className?: string
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          "mt-1 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-2xl tabular-nums",
          valueClassName ?? "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  )
}

function SpectrumLegend({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="size-2" style={{ background: swatch }} />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
    </div>
  )
}

function SectionHeader({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b bg-muted/40 px-4 py-2.5">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {typeof count === "number" ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

function agingTone(days: number) {
  if (days > 60) return "font-medium text-[var(--age-2)]"
  if (days > 30) return "text-[var(--age-1)]"
  return "text-muted-foreground"
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ community?: string; division?: string }> }) {
  const params = await searchParams
  const scope = await resolveProductionDeskScope({ communityId: params.community, divisionId: params.division })
  const [desk, report] = await Promise.all([loadOrgBillingDeskData(scope.projectIds), getOrgWipOverUnderReport()])
  const { stats } = desk

  // Per-project side signals attached to the ready-to-bill action list.
  const arByProject = new Map<string, number>()
  for (const invoice of desk.outstandingInvoices) {
    if (!invoice.projectId) continue
    arByProject.set(invoice.projectId, (arByProject.get(invoice.projectId) ?? 0) + invoice.balanceDueCents)
  }
  const wipByProject = new Map<string, WipOverUnderRow>(report.rows.map((row) => [row.project_id, row]))

  const overdueInvoices = desk.outstandingInvoices.filter((invoice) => {
    const days = daysUntilDue(invoice.dueDate)
    return invoice.status === "overdue" || (days !== null && days < 0)
  })
  const overdueCents = overdueInvoices.reduce((sum, invoice) => sum + invoice.balanceDueCents, 0)

  const readyProjects = desk.readyToBill // already sorted by amount desc
  const oldestReadyAge = readyProjects.reduce((max, project) => Math.max(max, project.oldestAgeDays), 0)
  const readyArTotal = readyProjects.reduce((sum, project) => sum + (arByProject.get(project.projectId) ?? 0), 0)

  return (
    <PageLayout title="Billing" fullBleed>
      <div>
        <DeskScopeFilters communities={scope.communities} divisions={scope.divisions} communityId={scope.communityId} divisionId={scope.divisionId} className="border-b px-4 py-2.5 sm:px-6" />
        {/* ── Instrument header: four figures, aging band below ────────── */}
        <section className="desk-rise border-b bg-card">
          <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
            <div className="flex flex-col divide-y divide-border md:flex-row md:items-stretch md:divide-x md:divide-y-0">
              <CompactStat
                label="Ready to bill"
                value={money(stats.readyToBillCents)}
                sub={`${readyProjects.length} ${readyProjects.length === 1 ? "project" : "projects"}${
                  oldestReadyAge > 0 ? ` · oldest ${oldestReadyAge}d` : ""
                }`}
                className="pb-5 md:flex-1 md:pb-0 md:pr-6"
              />
              <CompactStat
                label="Outstanding"
                value={money(stats.outstandingArCents)}
                sub={`${desk.outstandingInvoices.length} open`}
                className="py-5 md:flex-1 md:px-6 md:py-0"
              />
              <CompactStat
                label="Overdue"
                value={money(overdueCents)}
                valueClassName={overdueCents > 0 ? "text-[var(--age-2)]" : "text-muted-foreground"}
                sub={`${overdueInvoices.length} past due`}
                className="py-5 md:flex-1 md:px-6 md:py-0"
              />
              <CompactStat
                label="Retainage"
                value={money(stats.retainageHeldCents)}
                valueClassName="text-muted-foreground"
                sub="held"
                className="pt-5 md:flex-1 md:pl-6 md:pt-0"
              />
            </div>

            {/* Unbilled aging — full-width band, the page signature */}
            <div className="mt-5 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:gap-6">
              <Eyebrow className="shrink-0">Unbilled aging</Eyebrow>
              <Spectrum
                hero
                fresh={stats.aging0To30Cents}
                aging={stats.aging31To60Cents}
                stale={stats.aging61PlusCents}
                className="h-1.5 flex-1"
              />
              <div className="flex shrink-0 flex-wrap gap-x-5 gap-y-1 text-[11px]">
                <SpectrumLegend swatch={AGE_SWATCH.fresh} label="0–30" value={money(stats.aging0To30Cents)} />
                <SpectrumLegend swatch={AGE_SWATCH.aging} label="31–60" value={money(stats.aging31To60Cents)} />
                <SpectrumLegend swatch={AGE_SWATCH.stale} label="61+" value={money(stats.aging61PlusCents)} />
              </div>
            </div>
          </div>
        </section>

        {/* ── Working area ─────────────────────────────────────────────── */}
        <div className="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6 lg:px-8">
          <section
            className="desk-rise border bg-background"
            style={{ "--desk-stagger": 1 } as React.CSSProperties}
          >
            <SectionHeader title="Ready to bill" count={readyProjects.length}>
              <Button asChild variant="outline" size="sm">
                <a href="/api/reports/wip?format=csv">
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  WIP CSV
                </a>
              </Button>
            </SectionHeader>
            <div className="overflow-x-auto">
              <Table className={TABLE_EDGE}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-48">Project</TableHead>
                    <TableHead className="text-right">Ready to bill</TableHead>
                    <TableHead className="w-44 text-center">Unbilled aging</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {readyProjects.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                        Nothing is ready to bill. Approved, billable costs land here the moment they clear — ranked by
                        amount.
                      </TableCell>
                    </TableRow>
                  ) : (
                    readyProjects.map((project) => {
                      const wip = wipByProject.get(project.projectId)
                      const ar = arByProject.get(project.projectId) ?? 0
                      return (
                        <TableRow key={project.projectId} className="group relative cursor-pointer">
                          <TableCell>
                            <Link
                              href={project.href}
                              className="font-medium underline-offset-4 after:absolute after:inset-0 group-hover:underline"
                            >
                              {project.projectName}
                            </Link>
                            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                              {wip ? MODEL_LABELS[wip.billing_model] ?? wip.billing_model : null}
                              {wip && wip.issues.length > 0 ? (
                                <span
                                  className="inline-block size-1.5 bg-[var(--age-1)]"
                                  title={wip.issues.join(", ")}
                                />
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono font-medium tabular-nums">
                            {money(project.totalCents)}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center justify-center gap-2.5">
                              <Spectrum
                                fresh={project.aging0To30Cents}
                                aging={project.aging31To60Cents}
                                stale={project.aging61PlusCents}
                                className="h-1.5 w-20"
                              />
                              <span className={cn("tabular-nums", agingTone(project.oldestAgeDays))}>
                                {project.oldestAgeDays}d
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-right font-mono tabular-nums">
                            {ar > 0 ? money(ar) : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right">
                            <ArrowUpRight className="inline-block size-4 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
                {readyProjects.length > 0 ? (
                  <TableFooter>
                    <TableRow>
                      <TableCell className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Total
                      </TableCell>
                      <TableCell className="text-right font-mono font-medium tabular-nums">
                        {money(stats.readyToBillCents)}
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-right font-mono font-medium tabular-nums">
                        {readyArTotal > 0 ? money(readyArTotal) : "—"}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  </TableFooter>
                ) : null}
              </Table>
            </div>
          </section>

          <section
            className="desk-rise border bg-background"
            style={{ "--desk-stagger": 2 } as React.CSSProperties}
          >
            <SectionHeader title="Outstanding invoices" count={desk.outstandingInvoices.length}>
              <Button asChild variant="ghost" size="sm">
                <Link href="/invoices">
                  All invoices
                  <ArrowUpRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </SectionHeader>
            <div className="overflow-x-auto">
              <Table className={TABLE_EDGE}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead>Due</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {desk.outstandingInvoices.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-sm text-muted-foreground">
                        Nothing is awaiting payment. Sent invoices with an open balance collect here.
                      </TableCell>
                    </TableRow>
                  ) : (
                    desk.outstandingInvoices.map((invoice) => {
                      const due = dueLabel(invoice.dueDate)
                      const status = INVOICE_STATUS[invoice.status] ?? {
                        label: invoice.status,
                        dotClass: "bg-muted-foreground",
                      }
                      return (
                        <TableRow key={invoice.id} className="group relative cursor-pointer">
                          <TableCell>
                            <Link
                              href={invoice.href}
                              className="font-medium underline-offset-4 after:absolute after:inset-0 group-hover:underline"
                            >
                              <span className="font-mono tabular-nums">{invoice.invoiceNumber}</span>
                            </Link>
                            <div className="mt-0.5 max-w-64 truncate text-xs text-muted-foreground">
                              {invoice.title}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{invoice.projectName}</TableCell>
                          <TableCell className="text-center">
                            <Badge variant="outline" className="gap-1.5 capitalize">
                              <span className={cn("size-1.5", status.dotClass)} />
                              {status.label}
                            </Badge>
                          </TableCell>
                          <TableCell className={cn("text-xs", due.className)}>{due.text}</TableCell>
                          <TableCell className="text-right font-mono font-medium tabular-nums">
                            {money(invoice.balanceDueCents)}
                          </TableCell>
                        </TableRow>
                      )
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>
      </div>
    </PageLayout>
  )
}
