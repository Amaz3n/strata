"use client"

import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"

import type { Contract, CostCode, DrawSchedule, Invoice, Retainage, ScheduleItem } from "@/lib/types"
import type { PrimeSovState } from "@/lib/services/prime-sov"
import type { BillingManageSurface } from "@/lib/financials/billing-profile"
import {
  getProjectScheduleAction,
  listProjectDrawsAction,
  listProjectRetainageAction,
} from "@/app/(app)/projects/[id]/actions"
import { listCostCodesAction } from "@/app/(app)/projects/[id]/commitments/actions"
import { fetchPrimeSovAction } from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import { PrimeSovTab } from "@/components/financials/prime-sov-tab"
import { DrawScheduleManager } from "@/components/projects/draw-schedule-manager"

import { RecurringInvoices } from "./recurring-invoices"
import { RetainageLedger } from "./retainage-ledger"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Setup surfaces behind the billing book: contract schedules and supporting
 * ledgers that are maintained occasionally. Pay applications stay in the main
 * billing register because they are billing transactions, not setup.
 */

const SURFACE_COPY: Record<BillingManageSurface, { title: string; description: string }> = {
  draws: { title: "Draw schedule", description: "The contract's payment plan. Due draws appear in Up next on the billing book." },
  sov: { title: "Schedule of values", description: "The lines a pay application bills against." },
  retainage: { title: "Retainage", description: "What the customer is holding, and what has been released." },
  recurring: { title: "Recurring invoices", description: "Invoices that copy themselves on a cadence." },
}

export function BillingManageSheets({
  projectId,
  contract,
  costCodesEnabled,
  surface,
  progressBilling,
  onClose,
  onInvoiceCreated,
  onChanged,
}: {
  projectId: string
  contract: Contract | null
  costCodesEnabled: boolean
  progressBilling: boolean
  surface: BillingManageSurface | null
  onClose: () => void
  onInvoiceCreated: (invoice: Invoice | null) => void
  onChanged: () => void
}) {
  const copy = surface ? SURFACE_COPY[surface] : null
  return (
    <Sheet open={Boolean(surface)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <SheetHeader className="shrink-0 border-b px-6 py-4">
          <SheetTitle>{copy?.title ?? "Billing setup"}</SheetTitle>
          <SheetDescription>{copy?.description ?? ""}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {surface === "draws" ? (
            <DrawsSurface projectId={projectId} contract={contract} costCodesEnabled={costCodesEnabled} onInvoiceCreated={onInvoiceCreated} onChanged={onChanged} />
          ) : null}
          {surface === "sov" ? <SovSurface projectId={projectId} costCodesEnabled={costCodesEnabled} /> : null}
          {surface === "retainage" ? (
            <RetainageSurface projectId={projectId} progressBilling={progressBilling} onChanged={onChanged} />
          ) : null}
          {surface === "recurring" ? <RecurringInvoices projectId={projectId} onChanged={onChanged} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function SurfaceSkeleton() {
  return (
    <div className="space-y-3 p-6">
      <Skeleton className="h-9 w-full max-w-md" />
      <Skeleton className="h-64 w-full" />
    </div>
  )
}

function SurfaceError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="m-6 border border-destructive/30 p-4 text-sm"><p className="font-medium">This billing view could not load.</p><p className="mt-1 text-muted-foreground">{message}</p><Button className="mt-3" size="sm" variant="outline" onClick={onRetry}>Try again</Button></div>
}

function DrawsSurface({
  projectId,
  contract,
  costCodesEnabled,
  onInvoiceCreated,
  onChanged,
}: {
  projectId: string
  contract: Contract | null
  costCodesEnabled: boolean
  onInvoiceCreated: (invoice: Invoice) => void
  onChanged: () => void
}) {
  const [data, setData] = useState<{ draws: DrawSchedule[]; scheduleItems: ScheduleItem[]; costCodes: CostCode[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setLoadError(null)
    let cancelled = false
    Promise.all([
      listProjectDrawsAction(projectId),
      getProjectScheduleAction(projectId).catch(() => [] as ScheduleItem[]),
      costCodesEnabled ? listCostCodesAction().catch(() => [] as CostCode[]) : Promise.resolve([] as CostCode[]),
    ])
      .then(([draws, scheduleItems, costCodes]) => {
        if (!cancelled) setData({ draws, scheduleItems, costCodes })
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Please try again.") })
    return () => {
      cancelled = true
    }
  }, [costCodesEnabled, projectId, retry])
  if (loadError) return <SurfaceError message={loadError} onRetry={() => setRetry((value) => value + 1)} />
  if (!data) return <SurfaceSkeleton />
  return (
    <DrawScheduleManager
      projectId={projectId}
      initialDraws={data.draws}
      contract={contract}
      scheduleItems={data.scheduleItems}
      costCodes={data.costCodes}
      onInvoiceGenerated={(result) => {
        onInvoiceCreated(result.invoice)
        onChanged()
      }}
    />
  )
}

function SovSurface({ projectId, costCodesEnabled }: { projectId: string; costCodesEnabled: boolean }) {
  const [data, setData] = useState<{ sov: PrimeSovState; costCodes: CostCode[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setLoadError(null)
    let cancelled = false
    Promise.all([
      fetchPrimeSovAction(projectId).then(unwrapAction),
      costCodesEnabled ? listCostCodesAction().catch(() => [] as CostCode[]) : Promise.resolve([] as CostCode[]),
    ])
      .then(([sov, costCodes]) => {
        if (!cancelled) setData({ sov, costCodes })
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Please try again.") })
    return () => {
      cancelled = true
    }
  }, [costCodesEnabled, projectId, retry])
  if (loadError) return <SurfaceError message={loadError} onRetry={() => setRetry((value) => value + 1)} />
  if (!data) return <SurfaceSkeleton />
  return <PrimeSovTab projectId={projectId} sov={data.sov} costCodes={data.costCodes} costCodesEnabled={costCodesEnabled} />
}

function RetainageSurface({ projectId, progressBilling, onChanged }: { projectId: string; progressBilling: boolean; onChanged: () => void }) {
  const [data, setData] = useState<{ retainage: Retainage[]; sov: PrimeSovState | null } | null>(null)
  const [version, setVersion] = useState(0)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    setLoadError(null)
    let cancelled = false
    Promise.all([
      listProjectRetainageAction(projectId),
      progressBilling ? fetchPrimeSovAction(projectId).then(unwrapAction) : Promise.resolve(null),
    ])
      .then(([retainage, sov]) => {
        if (!cancelled) setData({ retainage, sov: sov?.summary ? sov : null })
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Please try again.") })
    return () => {
      cancelled = true
    }
  }, [progressBilling, projectId, version, retry])
  if (loadError) return <SurfaceError message={loadError} onRetry={() => setRetry((value) => value + 1)} />
  if (!data) return <SurfaceSkeleton />
  return (
    <RetainageLedger
      projectId={projectId}
      retainage={data.retainage}
      sov={data.sov}
      onChanged={() => {
        setVersion((current) => current + 1)
        onChanged()
      }}
    />
  )
}
