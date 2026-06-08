"use client"

import type { Contact, CostCode, Contract, DrawSchedule, Invoice, Project, Retainage } from "@/lib/types"
import { InvoicesClient } from "@/components/invoices/invoices-client"
import { DrawScheduleManager } from "@/components/projects/draw-schedule-manager"
import { RetainageTracker } from "@/components/projects/retainage-tracker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertTriangle, Receipt, Calendar, DollarSign, Percent } from "lucide-react"
import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { supportsApprovedCostInvoicing } from "@/lib/financials/billing-model"
import type { OwnerBillingPackageSummary } from "@/lib/services/owner-billing-packages"
import type { ProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import type { ProjectGmpControlSummary } from "@/lib/services/gmp-control"
import type { BillingAutopilotState } from "@/lib/services/billing-autopilot"
import { BillingAutopilotPanel } from "@/components/financials/billing-autopilot-panel"
import {
  createProjectFeeInvoiceAction,
  updateProjectFeeProgressAction,
} from "@/app/(app)/projects/[id]/financials/actions"

interface ReceivablesTabProps {
  projectId: string
  project: Project
  invoices: Invoice[]
  draws: DrawSchedule[]
  retainage: Retainage[]
  contacts?: Contact[]
  costCodes?: CostCode[]
  costCodesEnabled?: boolean
  ownerBillingPackages?: OwnerBillingPackageSummary[]
  feeSummary?: ProjectFeeBillingSummary | null
  gmpSummary?: ProjectGmpControlSummary | null
  autopilot?: BillingAutopilotState
  contract: Contract | null
  scheduleItems?: any[]
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  loadErrors?: string[]
}

export function ReceivablesTab({
  projectId,
  project,
  invoices,
  draws,
  retainage,
  contacts,
  costCodes,
  costCodesEnabled = true,
  ownerBillingPackages = [],
  feeSummary: initialFeeSummary = null,
  gmpSummary = null,
  autopilot = { enabled: false, run: null },
  contract,
  scheduleItems,
  builderInfo,
  loadErrors = [],
}: ReceivablesTabProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const invoiceParam = searchParams.get("invoice")
  const [subTab, setSubTab] = useState<"invoices" | "draws" | "retainage" | "fee">("invoices")
  const [localInvoices, setLocalInvoices] = useState<Invoice[]>(invoices)
  const [feeSummary, setFeeSummary] = useState<ProjectFeeBillingSummary | null>(initialFeeSummary)
  const [openInvoiceId, setOpenInvoiceId] = useState<string | undefined>()
  const [pendingInvoiceLabel, setPendingInvoiceLabel] = useState<string | undefined>()
  const [isFeePending, startFeeTransition] = useTransition()
  const safeRetainage = useMemo(() => (Array.isArray(retainage) ? retainage : []), [retainage])
  const safeInvoices = useMemo(() => (Array.isArray(localInvoices) ? localInvoices : []), [localInvoices])
  const invoiceProject = useMemo(
    () => ({ ...project, billing_contract: contract }),
    [project, contract],
  )
  const visibleCostCodes = costCodesEnabled ? costCodes : []
  const enableApprovedCostsSource = supportsApprovedCostInvoicing(contract)
  const showFeeTab = feeSummary?.enabled || feeSummary?.billing_model === "cost_plus_fixed_fee"

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

  const tabCounts = {
    invoices: safeInvoices.length,
    draws: draws.length,
    retainage: safeRetainage.length,
    fee: feeSummary?.enabled ? 1 : 0,
  }

  function handleFeeProgressSave(input: { scheduleId: string; percentComplete: number; totalFeeCents?: number }) {
    startFeeTransition(async () => {
      try {
        const next = await updateProjectFeeProgressAction({
          projectId,
          scheduleId: input.scheduleId,
          percentComplete: input.percentComplete,
          totalFeeCents: input.totalFeeCents,
        })
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
        const result = await createProjectFeeInvoiceAction({
          projectId,
          scheduleId: input.scheduleId,
          amountCents: input.amountCents,
          status: "saved",
          clientVisible: false,
        })
        setFeeSummary(result.feeSummary)
        setLocalInvoices((current) => [result.invoice, ...current.filter((invoice) => invoice.id !== result.invoice.id)])
        setOpenInvoiceId(result.invoice.id)
        setSubTab("invoices")
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
        {showFeeTab ? (
          <TabsTrigger
            value="fee"
            className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <DollarSign className="h-4 w-4" />
            Fee
            <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
              {tabCounts.fee}
            </Badge>
          </TabsTrigger>
        ) : null}
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
      </TabsList>
    )
  }

  return (
    <div className="w-full">
      <BillingAutopilotPanel projectId={projectId} initialState={autopilot} />
      {loadErrors.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6 lg:px-8 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">Some receivable data could not load.</span>
              <span className="text-amber-800/40 dark:text-amber-400/30">•</span>
              <span className="text-amber-800 dark:text-amber-300">{loadErrors.join(" · ")}</span>
            </div>
          </div>
        </div>
      ) : null}
      {gmpSummary?.enabled ? (
        <div
          className={`border-b px-4 py-3 text-sm sm:px-6 lg:px-8 ${
            gmpSummary.status === "overrun"
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : gmpSummary.status === "watch"
                ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200"
                : "bg-muted/30 text-muted-foreground"
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="font-medium text-foreground">GMP: {formatMoney(gmpSummary.revised_gmp_cents)}</div>
            <div>Inside EAC {formatMoney(gmpSummary.inside_gmp_eac_cents)}</div>
            <div>Outside GMP {formatMoney(gmpSummary.outside_gmp_eac_cents)}</div>
            <div>
              {gmpSummary.overrun_cents > 0
                ? `Overrun ${formatMoney(gmpSummary.overrun_cents)}`
                : `Savings ${formatMoney(gmpSummary.savings_cents)}`}
            </div>
            {gmpSummary.warnings[0] ? (
              <div className="flex min-w-0 items-center gap-1">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="truncate">{gmpSummary.warnings[0].message}</span>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "invoices" | "draws" | "retainage" | "fee")} className="w-full gap-0">
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
            enableApprovedCostsSource={enableApprovedCostsSource}
            toolbarLeading={renderTabList()}
            fullBleed
            projectScoped
          />
        </TabsContent>

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
                setSubTab("invoices")
              }}
              onInvoiceGenerated={(result) => {
                setLocalInvoices((current) => {
                  const withoutDuplicate = current.filter((invoice) => invoice.id !== result.invoice.id)
                  return [result.invoice, ...withoutDuplicate]
                })
                setPendingInvoiceLabel(undefined)
                setOpenInvoiceId(result.invoice_id)
                setSubTab("invoices")
                router.refresh()
              }}
              onInvoiceGenerationFailed={() => {
                setPendingInvoiceLabel(undefined)
              }}
            />
          </div>
        </TabsContent>

        <TabsContent value="retainage" className="m-0">
          <div className="border-b bg-background/95 px-4 sm:px-6 lg:px-8">{renderTabList()}</div>
          <div className="p-4 sm:p-6 lg:p-8">
            <RetainageTracker projectId={projectId} retainage={safeRetainage} />
          </div>
        </TabsContent>
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
  const [percentComplete, setPercentComplete] = useState(() => String(firstLine?.percent_complete ?? Math.round(summary?.project_percent_complete ?? 0)))
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
        <div className="border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
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
              <div className="text-right font-mono">{formatMoney(line.effective_earned_fee_cents ?? line.earned_fee_cents)}</div>
              <div className="text-right font-mono">{formatMoney(line.billed_fee_cents)}</div>
            </div>
          ))}
        </div>

        <div className="space-y-4 border p-4">
          <div>
            <div className="text-sm font-medium">Fee progress</div>
            <div className="mt-1 text-xs text-muted-foreground">Project WIP currently estimates {summary.project_percent_complete.toFixed(1)}% complete.</div>
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
              onClick={() => onSaveProgress({ scheduleId: schedule.id, percentComplete: percent })}
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
