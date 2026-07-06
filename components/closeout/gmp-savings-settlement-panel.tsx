"use client"

import { useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { CheckCircle2, DollarSign } from "lucide-react"

import { settleGmpSavingsAction } from "@/app/(app)/closeout/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ProjectGmpControlSummary } from "@/lib/services/gmp-control"
import { cn } from "@/lib/utils"

function formatMoney(cents?: number | null) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function formatDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function GmpSavingsSettlementPanel({
  projectId,
  projectStatus,
  summary,
}: {
  projectId: string
  projectStatus: string
  summary: ProjectGmpControlSummary
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const settledAt = summary.savings_settled_at ?? null
  const canSettle =
    !settledAt &&
    projectStatus === "completed" &&
    summary.savings_cents > 0 &&
    (summary.owner_savings_cents > 0 || summary.builder_savings_cents > 0)

  function handleSettle() {
    startTransition(async () => {
      try {
        await settleGmpSavingsAction(projectId)
        toast.success("GMP savings settled")
        router.refresh()
      } catch (error) {
        toast.error("Unable to settle GMP savings", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  return (
    <div className="mx-4 border bg-background p-4 sm:mx-0 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn(
                "text-[10px] uppercase",
                settledAt ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning",
              )}
            >
              {settledAt ? "Settled" : "GMP closeout"}
            </Badge>
            {settledAt ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                {formatDate(settledAt)}
              </span>
            ) : null}
          </div>
          <h2 className="mt-3 text-xl font-semibold tracking-tight">GMP savings settlement</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Final savings are calculated from the GMP control summary and recorded back to the active contract.
          </p>
        </div>
        <Button type="button" onClick={handleSettle} disabled={!canSettle || isPending}>
          <DollarSign className="mr-2 h-4 w-4" />
          {isPending ? "Settling..." : "Settle savings"}
        </Button>
      </div>

      <div className="mt-4 grid gap-px border bg-border sm:grid-cols-4">
        <Metric label="Forecast savings" value={formatMoney(summary.savings_cents)} />
        <Metric label="Owner credit" value={formatMoney(summary.owner_savings_cents)} />
        <Metric label="Builder share" value={formatMoney(summary.builder_savings_cents)} />
        <Metric label="Contingency left" value={formatMoney(summary.contingency_remaining_cents)} />
      </div>

      {summary.savings_settlement_invoice_ids?.length ? (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {summary.savings_settlement_invoice_ids.map((invoiceId) => (
            <Button key={invoiceId} asChild size="sm" variant="outline">
              <Link href={`/projects/${projectId}/financials/receivables?invoice=${invoiceId}`}>Open settlement invoice</Link>
            </Button>
          ))}
        </div>
      ) : null}

      {!settledAt && projectStatus !== "completed" ? (
        <p className="mt-3 text-xs text-muted-foreground">Mark the project complete before settling GMP savings.</p>
      ) : null}
      {!settledAt && projectStatus === "completed" && summary.savings_cents <= 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">No GMP savings are currently available to settle.</p>
      ) : null}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}
