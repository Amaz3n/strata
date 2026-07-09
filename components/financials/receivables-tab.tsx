"use client"

import type { Contact, CostCode, Contract, DrawSchedule, Invoice, Project, Retainage, ScheduleItem } from "@/lib/types"
import type { InvoiceArSummary } from "@/lib/services/invoices"
import { InvoicesClient } from "@/components/invoices/invoices-client"
import { PeriodCloseWorkflow } from "@/components/financials/period-close-workflow"
import { DrawScheduleManager } from "@/components/projects/draw-schedule-manager"
import { RetainageTracker } from "@/components/projects/retainage-tracker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertTriangle, Receipt, Calendar, DollarSign, PackageCheck, Percent } from "lucide-react"
import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import type { ProjectBillingModel } from "@/lib/financials/billing-model"
import type { BillingAutopilotState } from "@/lib/services/billing-autopilot"
import type { ProjectBillingPeriod } from "@/lib/services/billing-periods"
import type { ProjectGmpControlSummary } from "@/lib/services/gmp-control"
import type { OwnerBillingPackageSummary } from "@/lib/services/owner-billing-packages"
import type { ProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import {
  createProjectFeeInvoiceAction,
  updateProjectFeeProgressAction,
} from "@/app/(app)/projects/[id]/financials/actions"

import { unwrapAction } from "@/lib/action-result"

interface CloseWorkflowData {
  periods: ProjectBillingPeriod[]
  selectedPeriod: ProjectBillingPeriod | null
  summary: {
    reviewItemCount: number
    blockedItemCount: number
    readyCostIds: string[]
    readyCostCount: number
    readyCostCents: number
    lateCostCount: number
    lateCostCents: number
    oldestReadyCostDays: number
  }
  feeSummary?: ProjectFeeBillingSummary | null
  gmpSummary?: ProjectGmpControlSummary | null
  autopilot?: BillingAutopilotState
  loadErrors?: string[]
}

interface ReceivablesTabProps {
  projectId: string
  project: Project
  billingModel: ProjectBillingModel
  showDraws?: boolean
  showRetainage?: boolean
  closeWorkflow?: CloseWorkflowData | null
  invoices: Invoice[]
  draws: DrawSchedule[]
  retainage: Retainage[]
  contacts?: Contact[]
  costCodes?: CostCode[]
  costCodesEnabled?: boolean
  ownerBillingPackages?: OwnerBillingPackageSummary[]
  feeSummary?: ProjectFeeBillingSummary | null
  arSummary?: InvoiceArSummary | null
  contract: Contract | null
  scheduleItems?: ScheduleItem[]
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  loadErrors?: string[]
}

type ReceivablesSubTab = "invoices" | "close" | "fee" | "draws" | "retainage"

export function ReceivablesTab({
  projectId,
  project,
  billingModel,
  showDraws = false,
  showRetainage = true,
  closeWorkflow = null,
  invoices,
  draws,
  retainage,
  contacts,
  costCodes,
  costCodesEnabled = true,
  ownerBillingPackages = [],
  feeSummary: initialFeeSummary = null,
  arSummary = null,
  contract,
  scheduleItems,
  builderInfo,
  loadErrors = [],
}: ReceivablesTabProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const invoiceParam = searchParams.get("invoice")
  const tabParam = searchParams.get("tab")
  const showCloseTab = Boolean(closeWorkflow)
  const showFeeTab = billingModel === "cost_plus_fixed_fee" || Boolean(initialFeeSummary?.enabled)
  const visibleTabs = useMemo(() => {
    const tabs: ReceivablesSubTab[] = ["invoices"]
    if (showCloseTab) tabs.push("close")
    if (showFeeTab) tabs.push("fee")
    if (showDraws) tabs.push("draws")
    if (showRetainage) tabs.push("retainage")
    return tabs
  }, [showCloseTab, showFeeTab, showDraws, showRetainage])
  const [subTab, setSubTab] = useState<ReceivablesSubTab>(() =>
    tabParam && visibleTabs.includes(tabParam as ReceivablesSubTab) ? (tabParam as ReceivablesSubTab) : "invoices",
  )

  // Keep ?tab= in the URL so refreshes and shared links land on the same sub-tab.
  function changeSubTab(next: ReceivablesSubTab) {
    setSubTab(next)
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (next === "invoices") {
      params.delete("tab")
    } else {
      params.set("tab", next)
    }
    const search = params.toString()
    router.replace(window.location.pathname + (search ? `?${search}` : ""), { scroll: false })
  }
  const [localInvoices, setLocalInvoices] = useState<Invoice[]>(invoices)
  const [feeSummary, setFeeSummary] = useState<ProjectFeeBillingSummary | null>(initialFeeSummary)
  const [openInvoiceId, setOpenInvoiceId] = useState<string | undefined>()
  const [pendingInvoiceLabel, setPendingInvoiceLabel] = useState<string | undefined>()
  const [isFeePending, startFeeTransition] = useTransition()
  const safeRetainage = useMemo(() => (Array.isArray(retainage) ? retainage : []), [retainage])
  const safeInvoices = useMemo(() => (Array.isArray(localInvoices) ? localInvoices : []), [localInvoices])
  const invoiceProject = useMemo(() => ({ ...project, billing_contract: contract }), [project, contract])
  const visibleCostCodes = costCodesEnabled ? costCodes : []

  useEffect(() => {
    setLocalInvoices(invoices)
  }, [invoices])

  useEffect(() => {
    setFeeSummary(initialFeeSummary)
  }, [initialFeeSummary])

  useEffect(() => {
    if (invoiceParam) {
      setSubTab("invoices")
      setOpenInvoiceId(invoiceParam)
    }
  }, [invoiceParam])

  useEffect(() => {
    if (!invoiceParam && tabParam && visibleTabs.includes(tabParam as ReceivablesSubTab)) {
      setSubTab(tabParam as ReceivablesSubTab)
    }
  }, [invoiceParam, tabParam, visibleTabs])

  const tabCounts = {
    invoices: safeInvoices.length,
    close: closeWorkflow?.summary.readyCostCount ?? 0,
    draws: draws.length,
    retainage: safeRetainage.length,
  }

  function handleFeeProgressSave(input: { scheduleId: string; percentComplete: number; totalFeeCents?: number }) {
    startFeeTransition(async () => {
      try {
        const next = unwrapAction(await updateProjectFeeProgressAction({
          projectId,
          scheduleId: input.scheduleId,
          percentComplete: input.percentComplete,
          totalFeeCents: input.totalFeeCents,
        }))
        setFeeSummary(next)
        toast.success("Fee progress saved")
        router.refresh()
      } catch (error) {
        toast.error("Unable to save fee progress", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function handleFeeInvoiceCreate(input: { scheduleId: string; amountCents: number }) {
    startFeeTransition(async () => {
      try {
        const result = unwrapAction(await createProjectFeeInvoiceAction({
          projectId,
          scheduleId: input.scheduleId,
          amountCents: input.amountCents,
          status: "saved",
          clientVisible: false,
        }))
        setFeeSummary(result.feeSummary)
        setLocalInvoices((current) => [
          result.invoice,
          ...current.filter((invoice) => invoice.id !== result.invoice.id),
        ])
        setOpenInvoiceId(result.invoice.id)
        changeSubTab("invoices")
        toast.success("Fee invoice created")
        router.refresh()
      } catch (error) {
        toast.error("Unable to create fee invoice", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function renderTabList() {
    return (
      <TabsList className="h-auto min-h-14 w-full justify-start overflow-x-auto rounded-none bg-transparent p-0 sm:w-auto">
        <TabsTrigger
          value="invoices"
          className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          <Receipt className="h-4 w-4" />
          Invoices
          <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
            {tabCounts.invoices}
          </Badge>
        </TabsTrigger>
        {showCloseTab ? (
          <TabsTrigger
            value="close"
            className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <PackageCheck className="h-4 w-4" />
            Close &amp; Bill
            <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
              {tabCounts.close}
            </Badge>
          </TabsTrigger>
        ) : null}
        {showFeeTab ? (
          <TabsTrigger
            value="fee"
            className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <DollarSign className="h-4 w-4" />
            Fee
          </TabsTrigger>
        ) : null}
        {showDraws ? (
          <TabsTrigger
            value="draws"
            className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <Calendar className="h-4 w-4" />
            Draw Schedule
            <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
              {tabCounts.draws}
            </Badge>
          </TabsTrigger>
        ) : null}
        {showRetainage ? (
          <TabsTrigger
            value="retainage"
            className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <Percent className="h-4 w-4" />
            Retainage
            <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
              {tabCounts.retainage}
            </Badge>
          </TabsTrigger>
        ) : null}
      </TabsList>
    )
  }

  return (
    <div className="w-full">
      {loadErrors.length > 0 ? (
        <div className="border-b border-warning/30 bg-warning/10 px-4 py-3 text-sm text-foreground sm:px-6 lg:px-8">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">Some receivable data could not load.</span>
              <span className="text-muted-foreground/50">•</span>
              <span className="text-muted-foreground">{loadErrors.join(" · ")}</span>
            </div>
          </div>
        </div>
      ) : null}
      <Tabs value={subTab} onValueChange={(v) => changeSubTab(v as ReceivablesSubTab)} className="w-full gap-0">
        <TabsContent value="invoices" className="m-0">
          <InvoicesClient
            invoices={safeInvoices}
            projects={[invoiceProject]}
            initialOpenInvoiceId={openInvoiceId}
            onInitialOpenInvoiceHandled={() => setOpenInvoiceId(undefined)}
            pendingOpenInvoiceLabel={pendingInvoiceLabel}
            builderInfo={builderInfo}
            contacts={contacts}
            costCodes={visibleCostCodes}
            ownerBillingPackages={ownerBillingPackages}
            enableApprovedCostsSource={Boolean(closeWorkflow)}
            toolbarLeading={renderTabList()}
            arSummary={arSummary}
          />
        </TabsContent>

        {showCloseTab && closeWorkflow ? (
          <TabsContent value="close" className="m-0">
            <div className="border-b bg-background/95 px-4 sm:px-6 lg:px-8">{renderTabList()}</div>
            <PeriodCloseWorkflow
              projectId={projectId}
              billingModel={billingModel}
              periods={closeWorkflow.periods}
              selectedPeriod={closeWorkflow.selectedPeriod}
              summary={closeWorkflow.summary}
              feeSummary={closeWorkflow.feeSummary}
              gmpSummary={closeWorkflow.gmpSummary}
              autopilot={closeWorkflow.autopilot}
              loadErrors={closeWorkflow.loadErrors}
            />
          </TabsContent>
        ) : null}

        {showFeeTab ? (
          <TabsContent value="fee" className="m-0">
            <div className="border-b bg-background/95 px-4 sm:px-6 lg:px-8">{renderTabList()}</div>
            <FeeBillingPanel
              summary={feeSummary}
              isPending={isFeePending}
              onSaveProgress={handleFeeProgressSave}
              onCreateInvoice={handleFeeInvoiceCreate}
            />
          </TabsContent>
        ) : null}

        {showDraws ? (
          <TabsContent value="draws" className="m-0">
            <div className="border-b bg-background/95 px-4 sm:px-6 lg:px-8">{renderTabList()}</div>
            <div>
              <DrawScheduleManager
                projectId={projectId}
                initialDraws={draws}
                contract={contract}
                scheduleItems={scheduleItems}
                costCodes={visibleCostCodes}
                onInvoiceGenerationStart={(draw) => {
                  setOpenInvoiceId(undefined)
                  setPendingInvoiceLabel(`Draw ${draw.draw_number}: ${draw.title}`)
                  changeSubTab("invoices")
                }}
                onInvoiceGenerated={(result) => {
                  setLocalInvoices((current) => {
                    const withoutDuplicate = current.filter((invoice) => invoice.id !== result.invoice.id)
                    return [result.invoice, ...withoutDuplicate]
                  })
                  setPendingInvoiceLabel(undefined)
                  setOpenInvoiceId(result.invoice_id)
                  changeSubTab("invoices")
                  router.refresh()
                }}
                onInvoiceGenerationFailed={() => {
                  setPendingInvoiceLabel(undefined)
                }}
              />
            </div>
          </TabsContent>
        ) : null}

        {showRetainage ? (
          <TabsContent value="retainage" className="m-0">
            <div className="border-b bg-background/95 px-4 sm:px-6 lg:px-8">{renderTabList()}</div>
            <div className="p-4 sm:p-6 lg:p-8">
              <RetainageTracker projectId={projectId} retainage={safeRetainage} />
            </div>
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

function formatMoney(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function centsFromField(value: string) {
  const amount = Number(value.replace(/[$,\s]/g, ""))
  if (!Number.isFinite(amount) || amount < 0) return null
  return Math.round(amount * 100)
}

function FeeBillingPanel({
  summary,
  isPending,
  onSaveProgress,
  onCreateInvoice,
}: {
  summary: ProjectFeeBillingSummary | null
  isPending: boolean
  onSaveProgress: (input: { scheduleId: string; percentComplete: number; totalFeeCents?: number }) => void
  onCreateInvoice: (input: { scheduleId: string; amountCents: number }) => void
}) {
  const schedule = summary?.schedule ?? null
  const firstLine = summary?.lines[0]
  const [percentComplete, setPercentComplete] = useState(() =>
    String(firstLine?.percent_complete ?? Math.round(summary?.project_percent_complete ?? 0)),
  )
  const [invoiceAmount, setInvoiceAmount] = useState(() => ((summary?.billable_fee_cents ?? 0) / 100).toFixed(2))

  useEffect(() => {
    setPercentComplete(String(firstLine?.percent_complete ?? Math.round(summary?.project_percent_complete ?? 0)))
    setInvoiceAmount(((summary?.billable_fee_cents ?? 0) / 100).toFixed(2))
  }, [firstLine?.percent_complete, summary?.billable_fee_cents, summary?.project_percent_complete])

  if (!summary) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="border border-dashed p-6 text-sm text-muted-foreground">Fee billing data is not available.</div>
      </div>
    )
  }

  if (!summary.enabled || !schedule) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="border border-warning/30 bg-warning/10 p-4 text-sm text-foreground">
          {summary.reason ?? "Fee billing is not enabled for this project."}
        </div>
      </div>
    )
  }

  const percent = Number(percentComplete)
  const amountCents = centsFromField(invoiceAmount)
  const canSaveProgress = Number.isFinite(percent) && percent >= 0 && percent <= 100
  const canInvoice = amountCents != null && amountCents > 0 && amountCents <= summary.billable_fee_cents

  return (
    <div className="space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="grid gap-3 md:grid-cols-5">
        <FeeMetric label="Total fee" value={formatMoney(summary.total_fee_cents)} />
        <FeeMetric label="Earned" value={formatMoney(summary.earned_fee_cents)} />
        <FeeMetric label="Billed" value={formatMoney(summary.billed_fee_cents)} />
        <FeeMetric label="Billable now" value={formatMoney(summary.billable_fee_cents)} />
        <FeeMetric label="Remaining" value={formatMoney(summary.remaining_fee_cents)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="border">
          <div className="grid grid-cols-[1fr_120px_120px_120px] border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>Fee line</span>
            <span className="text-right">Scheduled</span>
            <span className="text-right">Earned</span>
            <span className="text-right">Billed</span>
          </div>
          {summary.lines.map((line) => (
            <div key={line.id} className="grid grid-cols-[1fr_120px_120px_120px] items-center px-3 py-3 text-sm">
              <div>
                <div className="font-medium">{line.name}</div>
                <div className="text-xs text-muted-foreground">{line.percent_complete.toFixed(1)}% complete</div>
              </div>
              <div className="text-right font-mono">{formatMoney(line.scheduled_fee_cents)}</div>
              <div className="text-right font-mono">
                {formatMoney(line.effective_earned_fee_cents ?? line.earned_fee_cents)}
              </div>
              <div className="text-right font-mono">{formatMoney(line.billed_fee_cents)}</div>
            </div>
          ))}
        </div>

        <div className="space-y-4 border p-4">
          <div>
            <div className="text-sm font-medium">Fee progress</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Project WIP currently estimates {summary.project_percent_complete.toFixed(1)}% complete.
            </div>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Input
              value={percentComplete}
              onChange={(event) => setPercentComplete(event.target.value)}
              inputMode="decimal"
              aria-label="Fee percent complete"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!canSaveProgress || isPending}
              onClick={() =>
                onSaveProgress({
                  scheduleId: schedule.id,
                  percentComplete: percent,
                })
              }
            >
              Save
            </Button>
          </div>

          <div className="border-t pt-4">
            <div className="text-sm font-medium">Create fee invoice</div>
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-2">
              <Input
                value={invoiceAmount}
                onChange={(event) => setInvoiceAmount(event.target.value)}
                inputMode="decimal"
                aria-label="Fee invoice amount"
              />
              <Button
                type="button"
                disabled={!canInvoice || isPending}
                onClick={() => amountCents != null && onCreateInvoice({ scheduleId: schedule.id, amountCents })}
              >
                Invoice
              </Button>
            </div>
            {amountCents != null && amountCents > summary.billable_fee_cents ? (
              <p className="mt-2 text-xs text-destructive">Amount cannot exceed earned unbilled fee.</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function FeeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border p-3">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm">{value}</div>
    </div>
  )
}
