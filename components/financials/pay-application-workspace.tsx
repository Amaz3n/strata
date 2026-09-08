"use client"

import dynamic from "next/dynamic"
import { loadWaiverPacketAction, setWaiverPacketAction } from "@/app/(app)/invoices/waiver-actions"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowLeft, Check, ChevronDown, FileText, Loader2, Send, X } from "lucide-react"
import { toast } from "sonner"

import {
  certifyPayApplicationAction,
  createPayApplicationAction,
  deletePayApplicationAction,
  generatePayApplicationPackageAction,
  generatePayApplicationPdfAction,
  loadPayApplicationWorkspaceAction,
  returnPayApplicationAction,
  sendPayApplicationAction,
  submitPayApplicationAction,
  updatePayApplicationLinesAction,
  voidPayApplicationAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import {
  computePayAppLine,
  computePayAppSummary,
  resolveRetainageRatePercent,
  thisPeriodFromPercentComplete,
} from "@/lib/financials/pay-app-math"
import { PayApplicationDeferralEditor } from "./pay-application-deferral-editor"
import { resolvePayApplicationDeferrals, type PayApplicationDeferralDraft, type DeferrablePayApplicationLine } from "@/lib/financials/pay-app-deferrals"
import type { PayApplicationProgressEvidence } from "@/lib/financials/pay-app-evidence"
import { changedPercentEntry, applyStoredMaterialMovement, mergePayApplicationEntry, type PayApplicationEntryDraft } from "@/lib/financials/pay-app-entry"
import { PAY_APPLICATION_STAGE_LABELS, stageIsPosted } from "@/lib/financials/pay-app-lifecycle"
import type { PayApplicationStage } from "@/lib/financials/pay-app-lifecycle"
import type {
  PayApplication,
  PayApplicationDetail,
  PayApplicationLine,
  PayApplicationWorkspaceContext,
} from "@/lib/services/pay-applications"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"

import { PayApplicationDocument, type PayApplicationDocumentData } from "./pay-application-document"

/**
 * The pay application, edited against its own document.
 *
 * Progress billing used to live in a sheet inside a tab: a 900px-wide grid
 * squeezed into a side panel, with the G702 it produces visible only as a
 * downloaded PDF after the fact. It is the primary billing act of a commercial
 * job, so it gets the same shape as the invoice composer — the numbers on the
 * left, the document the owner will certify on the right, updating as you type.
 *
 * It opens over the billing book rather than on a route of its own, so it is
 * immediate: no navigation, no server render between the click and the form.
 */

type EntryDraft = PayApplicationEntryDraft
type InternalCertificateInput = { signerName: string; signatureText: string; note: string; deferrals: ReturnType<typeof resolvePayApplicationDeferrals>["deferrals"] }

interface WorkspaceData {
  context: PayApplicationWorkspaceContext
  detail: PayApplicationDetail | null
  applications: PayApplication[]
}

const PacketWaiver = dynamic(() => import("@/components/invoices/invoice-packet-waiver").then(m=>m.InvoicePacketWaiver), {ssr:false})

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function moneyExact(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })
}

function centsFromField(value: string): number | null {
  if (value.trim() === "") return 0
  const amount = Number(value.replace(/[$,\s]/g, ""))
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

function formatDay(value?: string | null) {
  if (!value) return "—"
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return value
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))),
  )
}

const STAGE_TONE: Record<PayApplicationStage, string> = {
  draft: "border-border text-muted-foreground",
  returned: "border-warning/40 bg-warning/10 text-warning",
  submitted: "border-border text-foreground",
  awaiting_certification: "border-warning/40 bg-warning/10 text-warning",
  certified: "border-success/30 bg-success/10 text-success",
  billed: "border-border text-foreground",
  paid: "border-success/30 bg-success/10 text-success",
  void: "border-destructive/30 text-destructive",
}

export function PayApplicationWorkspace({
  projectId,
  target,
  onClose,
  onChanged,
  onInvoiceCreated,
  onOpenSov,
}: {
  projectId: string
  /** "new" starts an application; anything else opens that one. */
  target: string
  onClose: () => void
  onChanged: () => void
  onInvoiceCreated?: (invoiceId: string | null) => void
  /** Nothing can be billed without a schedule of values, so the empty state offers it. */
  onOpenSov: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const isNew = target === "new"

  const [data, setData] = useState<WorkspaceData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [entries, setEntries] = useState<Record<string, EntryDraft>>({})
  const [dirty, setDirty] = useState(false)
  const [allowOverbilling, setAllowOverbilling] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [certifyOpen, setCertifyOpen] = useState(false)
  const [returnOpen, setReturnOpen] = useState(false)
  const [sendOpen, setSendOpen] = useState(false)
  const [review, setReview] = useState(false)
  const [discardOpen, setDiscardOpen] = useState(false)
  const [progressEvidence, setProgressEvidence] = useState<PayApplicationProgressEvidence | null>(null)
  const [materialsLine, setMaterialsLine] = useState<PayApplicationLine | null>(null)
  const busyRef = useRef<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [includeWaiver,setIncludeWaiver] = useState(false)
  const [waiverView,setWaiverView] = useState(false)
  const [editingPercent, setEditingPercent] = useState(false)
  const editVersion = useRef(0)

  const requestClose = useCallback(() => {
    if (busyRef.current && busyRef.current !== "autosave") return
    if (dirty) setDiscardOpen(true)
    else onClose()
  }, [dirty, onClose])

  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])

  const detail = data?.detail ?? null
  const context = data?.context ?? null
  const application = detail?.application ?? null
  useEffect(()=>{
    if(!application?.invoice_id)return
    let active=true
    loadWaiverPacketAction(application.invoice_id).then(unwrapAction).then(result=>{if(active)setIncludeWaiver(Boolean(result.invoice.metadata?.waiver_packet?.enabled))}).catch(()=>{})
    return()=>{active=false}
  },[application?.invoice_id])
  const stage: PayApplicationStage = application?.stage ?? "draft"
  const isDraft = !application || application.status === "draft"
  const isRelease = application?.is_retainage_release ?? false

  const load = useCallback(
    async (openId: string | null) => {
      try {
        const result = unwrapAction(await loadPayApplicationWorkspaceAction(projectId, openId))
        setData(result)
        setLoadError(null)
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : "The pay application could not be loaded.")
      }
    },
    [projectId],
  )

  useEffect(() => {
    void load(isNew ? null : target)
  }, [isNew, load, target])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus()
    function trapFocus(event: KeyboardEvent) {
      if (event.key !== "Tab" || !rootRef.current?.contains(document.activeElement)) return
      const controls = Array.from(rootRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((element) => element.getClientRects().length > 0)
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    window.addEventListener("keydown", trapFocus)
    return () => { window.removeEventListener("keydown", trapFocus); previousFocus?.focus() }
  }, [])

  // Escape closes, unless a dialog inside is taking the key.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (certifyOpen || returnOpen || sendOpen || discardOpen || materialsLine || progressEvidence) return
      const active = document.activeElement
      if (active && rootRef.current && !rootRef.current.contains(active)) return
      event.preventDefault()
      requestClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [certifyOpen, requestClose, returnOpen, sendOpen, discardOpen, materialsLine, progressEvidence])

  function entryFor(line: PayApplicationLine): EntryDraft {
    return (
      entries[line.prime_sov_line_id] ?? {
        this_period: line.this_period_cents === 0 ? "" : (line.this_period_cents / 100).toFixed(2),
        stored: line.stored_materials_cents === 0 ? "" : (line.stored_materials_cents / 100).toFixed(2),
      }
    )
  }

  const liveLines = useMemo(() => {
    if (!detail) return []
    return detail.lines.map((line) => {
      const entry =
        entries[line.prime_sov_line_id] ?? {
          this_period: line.this_period_cents === 0 ? "" : (line.this_period_cents / 100).toFixed(2),
          stored: line.stored_materials_cents === 0 ? "" : (line.stored_materials_cents / 100).toFixed(2),
        }
      const thisPeriod = centsFromField(entry.this_period) ?? 0
      const stored = centsFromField(entry.stored) ?? 0
      const percentAfter =
        line.scheduled_value_cents > 0
          ? ((line.previous_billed_cents + thisPeriod) / line.scheduled_value_cents) * 100
          : 0
      const workRate = resolveRetainageRatePercent({
        percentComplete: percentAfter,
        schedule: detail.retainage_config.schedule,
        lineOverridePercent: line.retainage_percent_override,
        contractPercent: detail.retainage_config.contract_percent,
      })
      const storedRate = detail.retainage_config.stored_materials_percent ?? workRate
      return {
        line,
        computed: computePayAppLine({
          scheduledValueCents: line.scheduled_value_cents,
          previousBilledCents: line.previous_billed_cents,
          thisPeriodCents: thisPeriod,
          storedMaterialsCents: stored,
          previousStoredMaterialsCents: line.previous_stored_materials_cents,
          workRetainagePercent: workRate,
          storedMaterialsRetainagePercent: storedRate,
        }),
      }
    })
  }, [detail, entries])

  const liveSummary = useMemo(() => {
    if (!detail) return null
    if (!isDraft) return detail.summary
    const previousHeld = detail.summary.retainageCents - detail.summary.currentRetainageCents
    return computePayAppSummary({
      originalContractSumCents: detail.summary.contractSumToDateCents - detail.application.change_order_sum_cents,
      changeOrderSumCents: detail.application.change_order_sum_cents,
      previousRetainageHeldCents: previousHeld,
      previousCertificatesCents: detail.summary.previousCertificatesCents,
      lines: liveLines.map((row) => row.computed),
    })
  }, [detail, isDraft, liveLines])

  const evidenceByLine = useMemo(() => new Map((context?.progressEvidence ?? [])
    .filter((evidence) => !application || evidence.throughDate <= application.period_end)
    .map((evidence) => [evidence.primeSovLineId, evidence])), [application, context?.progressEvidence])

  const hasOverbilling = liveLines.some((row) => row.computed.overbilled)

  const documentData = useMemo<PayApplicationDocumentData | null>(() => {
    if (!context || !application || !liveSummary) return null
    if (!isDraft && detail?.report_snapshot) {
      return {
        ...detail.report_snapshot,
        certification: application.certification ? {
          signerName: application.certification.signer_name,
          certifiedAt: application.certification.certified_at,
          certifiedAmountCents: application.certification.certified_amount_cents,
          requestedAmountCents: application.certification.requested_amount_cents,
          deferredAmountCents: application.certification.deferred_amount_cents,
          note: application.certification.note,
        } : null,
      }
    }
    const storedBalance = liveLines.reduce((sum, row) => sum + row.computed.storedMaterialsCents, 0)
    const storedRate = context.storedMaterialsRetainagePercent ?? detail?.retainage_config.contract_percent ?? 0
    const retainageOnStored = Math.min(liveSummary.retainageCents, Math.round(storedBalance * (storedRate / 100)))
    return {
      applicationNumber: application.application_number,
      applicationDateIso: application.submitted_at ?? application.created_at ?? null,
      periodStartIso: application.period_start,
      periodToIso: application.period_end,
      projectName: context.projectName,
      propertyDescription: context.propertyDescription,
      ownerName: context.ownerName,
      contractorName: context.contractorName,
      contractDateIso: context.contractDateIso,
      invoiceNumber: null,
      isRetainageRelease: isRelease,
      revision: application.revision,
      originalContractSumCents: liveSummary.contractSumToDateCents - application.change_order_sum_cents,
      changeOrderSumCents: application.change_order_sum_cents,
      contractSumToDateCents: liveSummary.contractSumToDateCents,
      totalCompletedStoredCents: liveSummary.totalCompletedStoredCents,
      retainageCents: liveSummary.retainageCents,
      retainageOnCompletedWorkCents: liveSummary.retainageCents - retainageOnStored,
      retainageOnStoredMaterialsCents: retainageOnStored,
      totalEarnedLessRetainageCents: liveSummary.totalEarnedLessRetainageCents,
      previousCertificatesCents: liveSummary.previousCertificatesCents,
      currentPaymentDueCents: liveSummary.currentPaymentDueCents,
      balanceToFinishCents: liveSummary.balanceToFinishCents,
      changeOrders: context.changeOrders,
      submittedBy: null,
      certification: application.certification
        ? {
            signerName: application.certification.signer_name,
            certifiedAt: application.certification.certified_at,
            certifiedAmountCents: application.certification.certified_amount_cents,
            requestedAmountCents: application.certification.requested_amount_cents,
            deferredAmountCents: application.certification.deferred_amount_cents,
            note: application.certification.note,
          }
        : null,
    }
  }, [application, context, detail, isDraft, isRelease, liveLines, liveSummary])

  function updateEntry(line: PayApplicationLine, patch: Partial<EntryDraft>) {
    if (busyRef.current && busyRef.current !== "autosave") return
    editVersion.current += 1
    setEntries((current) => ({ ...current, [line.prime_sov_line_id]: mergePayApplicationEntry(current[line.prime_sov_line_id] ?? entryFor(line), patch) }))
    setDirty(true)
  }

  function setPercent(line: PayApplicationLine, percentText: string, evidence?: PayApplicationProgressEvidence) {
    const percent = Number(percentText)
    if (!Number.isFinite(percent)) return
    const thisPeriod = thisPeriodFromPercentComplete({
      scheduledValueCents: line.scheduled_value_cents,
      percentComplete: Math.min(100, Math.max(0, percent)),
      previousBilledCents: line.previous_billed_cents,
    })
    updateEntry(line, { this_period: (thisPeriod / 100).toFixed(2), progress_evidence: evidence ? { source_bill_ids: evidence.sourceBillIds, suggested_percent_complete: percent } : undefined })
  }

  function buildEntriesPayload() {
    if (!detail) return null
    const payload = []
    for (const line of detail.lines) {
      const entry = entryFor(line)
      const thisPeriod = centsFromField(entry.this_period)
      const stored = centsFromField(entry.stored)
      if (thisPeriod == null || stored == null) {
        toast.error(`Line ${line.line_number} has an amount that is not a number`)
        return null
      }
      if (stored < 0) {
        toast.error(`Line ${line.line_number}: stored materials cannot be negative`)
        return null
      }
      payload.push({
        prime_sov_line_id: line.prime_sov_line_id,
        this_period_cents: thisPeriod,
        stored_materials_cents: stored,
        progress_evidence: entry.progress_evidence,
      })
    }
    return payload
  }

  async function act<T>(key: string, run: () => Promise<T>, onDone?: (result: T) => void) {
    if (busyRef.current) return
    busyRef.current = key
    setBusy(key)
    try {
      const result = await run()
      onDone?.(result)
    } catch (error) {
      if (key === "save") setSaveError(error instanceof Error ? error.message : "Your latest changes could not be saved.")
      toast.error(error instanceof Error ? error.message : "That did not work. Try again.")
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  async function saveDraft(): Promise<PayApplicationDetail | null> {
    if (!detail || !application) return null
    const payload = buildEntriesPayload()
    if (!payload) return null
    const savingVersion = editVersion.current
    const saved = unwrapAction(
      await updatePayApplicationLinesAction(projectId, application.id, {
        entries: payload,
        allow_overbilling: allowOverbilling,
      }),
    )
    setData((current) => (current ? { ...current, detail: saved } : current))
    if (savingVersion === editVersion.current) {
      setEntries({})
      setDirty(false)
    }
    setSaveError(null)
    setSavedAt(new Date())
    return saved
  }

  const latestSave = useRef(saveDraft)
  useEffect(() => { latestSave.current = saveDraft })
  useEffect(() => {
    if (!dirty || !isDraft || !application || busy !== null || editingPercent || saveError || (hasOverbilling && !allowOverbilling)) return
    // Wait for a complete monetary entry, rather than persisting transient input.
    if (Object.values(entries).some((entry) => centsFromField(entry.this_period) == null || centsFromField(entry.stored) == null || (centsFromField(entry.stored) ?? 0) < 0)) return
    const timer = window.setTimeout(() => {
      if (busyRef.current) return
      busyRef.current = "autosave"
      setBusy("autosave")
      void latestSave.current().catch((error) => {
        setSaveError(error instanceof Error ? error.message : "Your latest changes could not be saved.")
      }).finally(() => {
        busyRef.current = null
        setBusy(null)
      })
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [allowOverbilling, application, busy, dirty, editingPercent, entries, hasOverbilling, isDraft, saveError])

  function startApplication() {
    if (!periodEnd) {
      toast.error("Pick the period this application covers")
      return
    }
    if (periodStart && periodStart > periodEnd) { toast.error("Period start must be on or before period end."); return }
    void act("create", async () => {
      const created = unwrapAction(
        await createPayApplicationAction(projectId, { period_end: periodEnd, period_start: periodStart || null }),
      )
      setData((current) => (current ? { ...current, detail: created } : current))
      await load(created.application.id)
      onChanged()
      toast.success(`Application #${created.application.application_number} started`)
    })
  }

  function submit() {
    if (!application) return
    if (context?.sovVarianceCents) { toast.error("Reconcile the schedule of values to the contract before preparing this application."); return }
    void act("submit", async () => {
      if (dirty) {
        const saved = await saveDraft()
        if (!saved) return
      }
      const result = unwrapAction(await submitPayApplicationAction(projectId, application.id))
      if (includeWaiver && result.detail.application.invoice_id) {
        unwrapAction(await setWaiverPacketAction(result.detail.application.invoice_id,true))
        setWaiverView(true)
      }
      setData((current) => (current ? { ...current, detail: result.detail, applications: result.payApplications } : current))
      onInvoiceCreated?.(result.detail.application.invoice_id)
      onChanged()
      toast.success(`Application #${result.detail.application.application_number} prepared`, {
        description: "Its invoice and application PDF are ready. Add and sign a waiver before sending if required.",
      })
    })
  }

  function send(recipients: string[], message: string) {
    if (!application) return
    void act("send", async () => {
      const detailResult = unwrapAction(
        await sendPayApplicationAction(projectId, application.id, { recipients, message: message || null }),
      )
      setData((current) => (current ? { ...current, detail: detailResult } : current))
      setSendOpen(false)
      onChanged()
      toast.success(
        detailResult.application.certification_required
          ? "Sent to the owner for certification"
          : "Sent to the customer",
      )
    })
  }

  function certify(input: InternalCertificateInput) {
    if (!application) return
    void act("certify", async () => {
      const result = unwrapAction(
        await certifyPayApplicationAction(projectId, application.id, {
          signerName: input.signerName,
          signatureText: input.signatureText,
          note: input.note || null,
          deferrals: input.deferrals,
        }),
      )
      setData((current) => (current ? { ...current, detail: result } : current))
      setCertifyOpen(false)
      onChanged()
      toast.success("Certificate recorded", { description: "The invoice has been issued." })
    })
  }

  function returnApplication(reason: string) {
    if (!application) return
    void act("return", async () => {
      const result = unwrapAction(await returnPayApplicationAction(projectId, application.id, { reason }))
      setData((current) => (current ? { ...current, detail: result } : current))
      setReturnOpen(false)
      onChanged()
      toast.success(`Returned as revision ${result.application.revision}`, {
        description: "The invoice was voided and the schedule of values reversed.",
      })
    })
  }

  function downloadPdf() {
    if (!application) return
    void act("pdf", async () => {
      const { fileName, pdfBase64 } = unwrapAction(await generatePayApplicationPdfAction(projectId, application.id))
      downloadBase64(pdfBase64, fileName)
    })
  }

  function downloadPackage() {
    if (!application) return
    void act("package", async () => {
      const result = unwrapAction(await generatePayApplicationPackageAction(projectId, application.id, { includeGcCompliance: true }))
      downloadBase64(result.pdfBase64, result.fileName)
      toast.success("Owner package generated", {
        description: `${result.package.proof_count} supporting file${result.package.proof_count === 1 ? "" : "s"} listed on the manifest.`,
      })
    })
  }

  function deleteDraft() {
    if (!application) return
    void act("delete", async () => {
      unwrapAction(await deletePayApplicationAction(projectId, application.id))
      onChanged()
      toast.success("Draft deleted")
      onClose()
    })
  }

  function voidApplication() {
    if (!application) return
    void act("void", async () => {
      const result = unwrapAction(await voidPayApplicationAction(projectId, application.id))
      setData((current) => (current ? { ...current, detail: result } : current))
      onChanged()
      toast.success("Pay application voided")
    })
  }

  const latestReturn = application?.returns?.[application.returns.length - 1] ?? null

  return (
    <div ref={rootRef} role="dialog" aria-modal="true" aria-label="Pay application" className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={requestClose} aria-label="Close">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">
              {application
                ? `${isRelease ? "Retainage release" : "Pay application"} #${application.application_number}`
                : "New pay application"}
            </h1>
            {application ? (
              <Badge variant="outline" className={cn("h-5 rounded-none px-1.5 text-[11px] font-normal", STAGE_TONE[stage])}>
                {PAY_APPLICATION_STAGE_LABELS[stage]}
              </Badge>
            ) : null}
            {application && application.revision > 0 ? (
              <span className="text-xs text-muted-foreground">Revision {application.revision}</span>
            ) : null}
          </div>
          <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {application ? (
              <span>
                {application.period_start ? `${formatDay(application.period_start)} — ` : "Through "}
                {formatDay(application.period_end)}
              </span>
            ) : (
              <span>Enter the period this application covers</span>
            )}
            {busy === "autosave" ? <span role="status">Saving…</span> : dirty ? <span className="text-warning">Unsaved changes</span> : savedAt ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Check className="h-3 w-3" />
                Saved {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(savedAt)}
              </span>
            ) : null}
          </p>
        </div>

        <WorkspaceActions
          application={application}
          stage={stage}
          busy={busy}
          dirty={dirty}
          hasOverbilling={hasOverbilling}
          allowOverbilling={allowOverbilling}
          onSave={() => void act("save", saveDraft)}
          onSubmit={submit}
          onSend={() => setSendOpen(true)}
          onCertify={() => setCertifyOpen(true)}
          onReturn={() => setReturnOpen(true)}
          onDownloadPdf={downloadPdf}
          onDownloadPackage={downloadPackage}
          onDelete={deleteDraft}
          onVoid={voidApplication}
        />
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={requestClose} aria-label="Close workspace">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {saveError ? <div role="alert" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-destructive/30 px-4 py-2 text-sm"><span className="text-destructive">Changes not saved: {saveError}</span><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => { setSaveError(null); void act("save", saveDraft) }}>Retry save</Button></div> : null}
      {application && liveSummary ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 lg:px-6">
          <dl className="flex flex-wrap gap-x-8 gap-y-2 text-xs">
            <div><dt className="text-muted-foreground">Payment requested</dt><dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{moneyExact(liveSummary.currentPaymentDueCents)}</dd></div>
            {application.certification ? <>
              <div><dt className="text-muted-foreground">Certified</dt><dd className="mt-1 font-mono tabular-nums">{moneyExact(application.certification.certified_amount_cents)}</dd></div>
              {application.certification.deferred_amount_cents ? <div><dt className="text-muted-foreground">Deferred</dt><dd className="mt-1 font-mono tabular-nums">{moneyExact(application.certification.deferred_amount_cents)}</dd></div> : null}
            </> : null}
            <div><dt className="text-muted-foreground">Completed &amp; stored</dt><dd className="mt-1 font-mono tabular-nums">{moneyExact(liveSummary.totalCompletedStoredCents)}</dd></div>
            <div><dt className="text-muted-foreground">Retainage held</dt><dd className="mt-1 font-mono tabular-nums">{moneyExact(liveSummary.retainageCents)}</dd></div>
            <div><dt className="text-muted-foreground">Balance to finish</dt><dd className="mt-1 font-mono tabular-nums">{moneyExact(liveSummary.balanceToFinishCents)}</dd></div>
          </dl>
          <div className="flex gap-1" aria-label="Application view">
            <Button size="sm" variant={!review ? "secondary" : "ghost"} aria-pressed={!review} onClick={() => setReview(false)}>Progress</Button>
            <Button size="sm" variant={review ? "secondary" : "ghost"} aria-pressed={review} onClick={() => setReview(true)}>Review document</Button>
          </div>
        </div>
      ) : null}
      <div className="flex shrink-0 items-center justify-between border-b px-5 py-2">
        <div className="flex gap-1"><Button size="sm" variant={!waiverView?"secondary":"ghost"} onClick={()=>setWaiverView(false)}>Application</Button>{includeWaiver&&application?.invoice_id&&<Button size="sm" variant={waiverView?"secondary":"ghost"} onClick={()=>setWaiverView(true)}>Waiver</Button>}</div>
        <label className="flex items-center gap-2 text-xs"><Checkbox checked={includeWaiver} disabled={busy!==null} onCheckedChange={value=>{
          const enabled=value===true
          if(application?.invoice_id)void act("waiver",async()=>{unwrapAction(await setWaiverPacketAction(application.invoice_id!,enabled));setIncludeWaiver(enabled);setWaiverView(enabled)})
          else setIncludeWaiver(enabled)
        }}/>{includeWaiver&&!application?.invoice_id?"Waiver follows application preparation":"Include waiver"}</label>
      </div>
      {includeWaiver&&application?.invoice_id&&<div className={cn("flex min-h-0 flex-1",!waiverView&&"hidden")}><PacketWaiver invoiceId={application.invoice_id} onClose={()=>setWaiverView(false)}/></div>}
      {/* Body */}
      <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row",waiverView&&"hidden")}>
        <div className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 lg:px-6", review && "hidden")}>
          {loadError ? (
            <div className="border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              {loadError}
              <Button variant="outline" size="sm" className="ml-3 h-7" onClick={() => void load(isNew ? null : target)}>
                Try again
              </Button>
            </div>
          ) : !data ? (
            <div className="space-y-3">
              <Skeleton className="h-9 w-64" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : !application ? (
            <StartPanel
              periodStart={periodStart}
              periodEnd={periodEnd}
              onPeriodStart={setPeriodStart}
              onPeriodEnd={setPeriodEnd}
              onStart={startApplication}
              busy={busy === "create"}
              lastPeriodEnd={data.applications.find((app) => app.status !== "void")?.period_end ?? null}
              hasSovLines={data.context.hasSovLines}
              onOpenSov={onOpenSov}
            />
          ) : (
            <div className="space-y-4">
              {latestReturn && stage === "returned" ? (
                <div className="border border-warning/40 bg-warning/10 p-3 text-sm">
                  <p className="font-medium text-warning">Returned by the owner</p>
                  <p className="mt-1 text-foreground">{latestReturn.reason}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {latestReturn.actor_name ? `${latestReturn.actor_name} · ` : ""}
                    {formatDay(latestReturn.returned_at.slice(0, 10))}
                  </p>
                </div>
              ) : null}

              {application.certification ? (
                <div className="border border-success/30 bg-success/10 p-3 text-sm">
                  <p className="font-medium text-success">
                    Certified for {moneyExact(application.certification.certified_amount_cents)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {application.certification.signer_name} ·{" "}
                    {formatDay(application.certification.certified_at.slice(0, 10))}
                    {application.certification.source === "internal" ? " · recorded in Arc" : " · signed in the owner portal"}
                  </p>
                  {application.certification.note ? (
                    <p className="mt-1 text-foreground">{application.certification.note}</p>
                  ) : null}
                </div>
              ) : null}

              {isDraft && context && context.sovVarianceCents !== 0 ? (
                <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border border-warning/40 p-3 text-sm">
                  <p>The schedule of values differs from the contract by {moneyExact(context.sovVarianceCents)}. Reconcile it before preparing this application.</p>
                  <Button size="sm" variant="outline" onClick={() => { if (dirty) { toast.error("Save your progress before opening the schedule of values."); return }; onOpenSov() }}>Review schedule of values</Button>
                </div>
              ) : null}
              {hasOverbilling ? (
                <div className="flex items-start gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <div className="space-y-1.5">
                    <p>One or more lines bill past their scheduled value.</p>
                    {isDraft ? (
                      <label className="flex items-center gap-2 text-xs">
                        <Checkbox
                          disabled={busy !== null}
                          checked={allowOverbilling}
                          onCheckedChange={(checked) => setAllowOverbilling(checked === true)}
                        />
                        Allow overbilling on this application
                      </label>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {isRelease ? (
                <div className="border p-4 text-sm">
                  <p className="font-medium">Retainage release</p>
                  <p className="mt-1 text-muted-foreground">
                    This application releases held retainage. It has no schedule-of-values entry of its own.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto border">
                  <Table className="min-w-[980px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10 text-right">#</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead className="w-28 text-right">Scheduled</TableHead>
                        <TableHead className="w-28 text-right">Previous</TableHead>
                        <TableHead className="w-28 text-right">This period</TableHead>
                        <TableHead className="w-24 text-right">Work complete %</TableHead>
                        <TableHead className="w-32 text-right">Stored balance</TableHead>
                        <TableHead className="w-28 text-right">Total + stored</TableHead>
                        <TableHead className="w-28 text-right">Balance</TableHead>
                        <TableHead className="w-24 text-right">Retainage</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {liveLines.map(({ line, computed }) => {
                        const entry = entryFor(line)
                        const evidence = evidenceByLine.get(line.prime_sov_line_id)
                        return (
                          <TableRow key={line.id} className={computed.overbilled ? "bg-warning/5" : undefined}>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {line.line_number}
                            </TableCell>
                            <TableCell className="sticky left-0 z-10 max-w-56 bg-background">
                              <div className="truncate text-sm" title={line.description}>
                                {line.description}
                              </div>
                              {entry.progress_evidence ? <p className="mt-1 text-[10px] text-success">Reviewed progress · pending save</p> : line.progress_evidence ? <details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">{(centsFromField(entry.this_period) ?? 0) === line.progress_evidence.applied_work_cents ? "Reviewed progress" : "Adjusted after review"} · {formatDay(line.progress_evidence.accepted_at.slice(0, 10))}</summary><p className="mt-2 whitespace-normal">{line.progress_evidence.note}</p><p className="mt-1">Reviewed work this period: {moneyExact(line.progress_evidence.applied_work_cents)}</p><div className="mt-1 flex flex-wrap gap-2">{line.progress_evidence.source_bill_ids.map((id, index) => <a key={id} className="underline underline-offset-2" href={`/projects/${projectId}/financials/payables?bill=${id}`} target="_blank" rel="noopener noreferrer">Source bill {index + 1} ↗</a>)}</div></details> : null}
                              {isDraft && evidence ? <Button variant="link" size="sm" className="h-auto px-0 py-1 text-xs" disabled={busy !== null && busy !== "autosave"} onClick={() => setProgressEvidence(evidence)}>{evidence.suggestedPercentComplete != null ? `Review ${evidence.suggestedPercentComplete}% subcontract progress` : "Review linked subcontract progress"}</Button> : null}
                              {line.cost_code_label ? (
                                <div className="truncate text-xs text-muted-foreground">{line.cost_code_label}</div>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {money(line.scheduled_value_cents)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums text-muted-foreground">
                              {money(line.previous_billed_cents)}
                            </TableCell>
                            <TableCell className="text-right">
                              {isDraft ? (
                                <Input
                                  disabled={busy !== null && busy !== "autosave"}
                                  value={entry.this_period}
                                  onChange={(event) => updateEntry(line, { this_period: event.target.value })}
                                  inputMode="decimal"
                                  placeholder="0.00"
                                  className="h-7 border-transparent bg-transparent px-1 text-right font-mono text-sm tabular-nums shadow-none focus-visible:border-input"
                                  aria-label={`Line ${line.line_number} this period`}
                                />
                              ) : (
                                <span className="font-mono text-sm tabular-nums">{money(line.this_period_cents)}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {isDraft ? (
                                <Input
                                  disabled={busy !== null && busy !== "autosave"}
                                  key={`${line.id}-${computed.percentComplete.toFixed(2)}`}
                                  defaultValue={computed.percentComplete ? computed.percentComplete.toFixed(2) : ""}
                                  onFocus={() => setEditingPercent(true)}
                                  onBlur={(event) => {
                                    setEditingPercent(false)
                                    const value = changedPercentEntry(event.target.value, event.target.defaultValue)
                                    if (value !== null) setPercent(line, String(value))
                                    else event.target.value = event.target.defaultValue
                                  }}
                                  inputMode="decimal"
                                  placeholder="%"
                                  className="h-7 w-14 border-transparent bg-transparent px-1 text-right font-mono text-xs tabular-nums shadow-none focus-visible:border-input"
                                  aria-label={`Line ${line.line_number} percent complete`}
                                />
                              ) : (
                                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                  {computed.percentComplete.toFixed(1)}%
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {isDraft ? (
                                <Button variant="ghost" size="sm" disabled={busy !== null && busy !== "autosave"} onClick={() => setMaterialsLine(line)} className="h-auto min-h-8 w-full flex-col items-end px-1 font-mono tabular-nums" aria-label={`Line ${line.line_number} stored material movements`}>
                                  <span>{moneyExact(centsFromField(entry.stored) ?? 0)}</span>
                                  <span className="font-sans text-[10px] text-muted-foreground">Add / install</span>
                                </Button>
                              ) : (
                                <span className="font-mono text-sm tabular-nums">{money(line.stored_materials_cents)}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {money(computed.totalCompletedAndStoredCents)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums text-muted-foreground">
                              {money(computed.balanceToFinishCents)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm tabular-nums">
                              {money(isDraft ? computed.retainageCents : line.retainage_cents)}
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* The document the owner certifies. */}
        <div className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6", !review && "hidden")}>
          {documentData ? (
            <div className="space-y-6">
              <DocumentPreview data={documentData} />
              {!isRelease ? <div className="mx-auto max-w-6xl overflow-x-auto border bg-background p-4">
                <h2 className="mb-3 text-sm font-semibold">Continuation sheet</h2>
                <Table className="min-w-[800px]"><TableHeader><TableRow><TableHead>Scope</TableHead><TableHead className="text-right">Scheduled</TableHead><TableHead className="text-right">Previous</TableHead><TableHead className="text-right">This period</TableHead><TableHead className="text-right">Stored</TableHead><TableHead className="text-right">Completed &amp; stored</TableHead><TableHead className="text-right">Retainage this period</TableHead></TableRow></TableHeader><TableBody>
                  {liveLines.map(({ line, computed }) => <TableRow key={line.id}><TableCell>{line.line_number}. {line.description}</TableCell><TableCell className="text-right font-mono tabular-nums">{moneyExact(line.scheduled_value_cents)}</TableCell><TableCell className="text-right font-mono tabular-nums">{moneyExact(line.previous_billed_cents)}</TableCell><TableCell className="text-right font-mono tabular-nums">{moneyExact(isDraft ? computed.thisPeriodCents : line.this_period_cents)}</TableCell><TableCell className="text-right font-mono tabular-nums">{moneyExact(isDraft ? computed.storedMaterialsCents : line.stored_materials_cents)}</TableCell><TableCell className="text-right font-mono tabular-nums">{moneyExact(computed.totalCompletedAndStoredCents)}</TableCell><TableCell className="text-right font-mono tabular-nums">{moneyExact(isDraft ? computed.retainageCents : line.retainage_cents)}</TableCell></TableRow>)}
                </TableBody></Table>
              </div> : null}
            </div>
          ) : (
            <div className="mx-auto max-w-[816px]">
              <Skeleton className="aspect-[816/1056] w-full" />
            </div>
          )}
        </div>
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent><DialogHeader><DialogTitle>Keep your progress?</DialogTitle><DialogDescription>You have unsaved changes in this application.</DialogDescription></DialogHeader><DialogFooter>
          <Button variant="ghost" disabled={busy !== null} onClick={() => { setDiscardOpen(false); onClose() }}>Discard changes</Button>
          <Button variant="outline" onClick={() => setDiscardOpen(false)}>Keep editing</Button>
          <Button disabled={busy !== null} onClick={() => void act("save", async () => { if (await saveDraft()) { setDiscardOpen(false); onClose() } })}>Save and close</Button>
        </DialogFooter></DialogContent>
      </Dialog>
      {progressEvidence ? <ProgressEvidenceDialog evidence={progressEvidence} projectId={projectId} onClose={() => setProgressEvidence(null)} onAccept={() => {
        const line = detail?.lines.find((item) => item.prime_sov_line_id === progressEvidence.primeSovLineId)
        if (line && progressEvidence.suggestedPercentComplete != null) setPercent(line, String(progressEvidence.suggestedPercentComplete), progressEvidence)
        setProgressEvidence(null)
      }} /> : null}
      {materialsLine ? <StoredMaterialsDialog line={materialsLine} endingCents={centsFromField(entryFor(materialsLine).stored) ?? 0} workCents={centsFromField(entryFor(materialsLine).this_period) ?? 0} onClose={() => setMaterialsLine(null)} onApply={(work, stored) => { updateEntry(materialsLine, { this_period: (work / 100).toFixed(2), stored: (stored / 100).toFixed(2) }); setMaterialsLine(null) }} /> : null}
      {application ? (
        <>
          <SendDialog
            open={sendOpen}
            onOpenChange={setSendOpen}
            includesWaiver={includeWaiver}
            defaultRecipient={context?.ownerEmail ?? ""}
            certificationRequired={application.certification_required}
            amountCents={application.current_payment_due_cents}
            busy={busy === "send"}
            onSend={send}
          />
          <CertifyDialog
            open={certifyOpen}
            onOpenChange={setCertifyOpen}
            lines={(detail?.lines ?? []).map((line) => ({ id: line.prime_sov_line_id, description: line.description, maxCents: line.maximum_deferrable_cents ?? 0 })).filter((line) => line.maxCents > 0)}
            amountCents={application.requested_payment_cents ?? application.current_payment_due_cents}
            busy={busy === "certify"}
            onCertify={certify}
          />
          <ReturnDialog
            open={returnOpen}
            onOpenChange={setReturnOpen}
            applicationNumber={application.application_number}
            busy={busy === "return"}
            onReturn={returnApplication}
          />
        </>
      ) : null}
    </div>
  )
}

function WorkspaceActions({
  application,
  stage,
  busy,
  dirty,
  hasOverbilling,
  allowOverbilling,
  onSave,
  onSubmit,
  onSend,
  onCertify,
  onReturn,
  onDownloadPdf,
  onDownloadPackage,
  onDelete,
  onVoid,
}: {
  application: PayApplication | null
  stage: PayApplicationStage
  busy: string | null
  dirty: boolean
  hasOverbilling: boolean
  allowOverbilling: boolean
  onSave: () => void
  onSubmit: () => void
  onSend: () => void
  onCertify: () => void
  onReturn: () => void
  onDownloadPdf: () => void
  onDownloadPackage: () => void
  onDelete: () => void
  onVoid: () => void
}) {
  if (!application) return null
  const pending = busy !== null
  const posted = stageIsPosted(stage)
  if (stage === "void") return <Button variant="outline" size="sm" onClick={onDownloadPdf} disabled={pending}>Download void application</Button>

  if (!posted) {
    return (
      <div className="flex items-center gap-2">
        {dirty ? (
          <Button variant="outline" size="sm" className="h-8" onClick={onSave} disabled={pending}>
            {busy === "save" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Save
          </Button>
        ) : null}
        <div className="flex items-stretch">
          <Button
            size="sm"
            className="h-8 rounded-r-none"
            onClick={onSubmit}
            disabled={pending || (hasOverbilling && !allowOverbilling)}
          >
            {busy === "submit" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Prepare application
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="h-8 rounded-l-none border-l border-primary-foreground/20 px-2" aria-label="More">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={onDelete}
                disabled={pending}
              >
                Delete draft
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    )
  }

  const sendLabel = application.sent_to_owner ? "Resend" : application.certification_required ? "Send for certification" : "Send"
  const showSend = stage === "submitted" || stage === "awaiting_certification"

  return (
    <div className="flex items-center gap-2">
      {showSend ? (
        <div className="flex items-stretch">
          <Button size="sm" className="h-8 rounded-r-none" onClick={onSend} disabled={pending}>
            {busy === "send" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-3.5 w-3.5" />
            )}
            {sendLabel}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="h-8 rounded-l-none border-l border-primary-foreground/20 px-2" aria-label="More actions">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={onCertify}>Record the owner&apos;s certificate…</DropdownMenuItem>
              <DropdownMenuItem onSelect={onReturn}>Return for revision…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onDownloadPdf}>Download application</DropdownMenuItem>
              <DropdownMenuItem onSelect={onDownloadPackage}>Download owner package</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onVoid}>
                Void application
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : (
        <div className="flex items-stretch">
          <Button variant="outline" size="sm" className="h-8 rounded-r-none" onClick={onDownloadPdf} disabled={pending}>
            {busy === "pdf" ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <FileText className="mr-1.5 h-3.5 w-3.5" />
            )}
            Download
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 rounded-l-none border-l px-2" aria-label="More actions">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={onDownloadPackage}>Download owner package</DropdownMenuItem>
              {stage !== "paid" ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={onVoid}>
                    Void application
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  )
}

function StartPanel({
  periodStart,
  periodEnd,
  onPeriodStart,
  onPeriodEnd,
  onStart,
  busy,
  lastPeriodEnd,
  hasSovLines,
  onOpenSov,
}: {
  periodStart: string
  periodEnd: string
  onPeriodStart: (value: string) => void
  onPeriodEnd: (value: string) => void
  onStart: () => void
  busy: boolean
  lastPeriodEnd: string | null
  hasSovLines: boolean
  onOpenSov: () => void
}) {
  const suggestedPeriod = useRef(false)
  useEffect(() => {
    if (suggestedPeriod.current) return
    suggestedPeriod.current = true
    const now = new Date()
    const last = lastPeriodEnd ? new Date(`${lastPeriodEnd}T12:00:00`) : null
    const next = last ? new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1) : new Date(now.getFullYear(), now.getMonth(), 1)
    const end = new Date(next.getFullYear(), next.getMonth() + 1, 0)
    const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
    if (!periodStart) onPeriodStart(iso(next))
    if (!periodEnd) onPeriodEnd(iso(end))
  }, [lastPeriodEnd, onPeriodStart, onPeriodEnd, periodStart, periodEnd])

  // Creating one without a schedule of values throws from the service. Saying
  // so here, with the way to fix it, beats a toast after the click.
  if (!hasSovLines) {
    return (
      <div className="mx-auto max-w-xl border p-6">
        <h2 className="text-sm font-semibold">Build the schedule of values first</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A pay application bills progress against the schedule of values, so there is nothing to bill until it has
          lines. Import it from the budget or the estimate, or enter it by hand.
        </p>
        <Button className="mt-4" variant="outline" onClick={onOpenSov}>
          Open the schedule of values
        </Button>
      </div>
    )
  }
  return (
    <div className="mx-auto max-w-xl border p-6">
      <h2 className="text-sm font-semibold">Start a pay application</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Previous progress and stored balances carry forward. Review installed work and material movements for this period, then prepare the application for sending.
      </p>
      {lastPeriodEnd ? (
        <p className="mt-2 text-xs text-muted-foreground">The last application ran through {formatDay(lastPeriodEnd)}.</p>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="payapp-period-start" className="text-xs">
            Period start <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input id="payapp-period-start" type="date" value={periodStart} onChange={(event) => onPeriodStart(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="payapp-period-end" className="text-xs">
            Period end
          </Label>
          <Input id="payapp-period-end" type="date" value={periodEnd} onChange={(event) => onPeriodEnd(event.target.value)} />
        </div>
      </div>
      <Button className="mt-4" onClick={onStart} disabled={busy || !periodEnd}>
        {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
        Start application
      </Button>
    </div>
  )
}

function DocumentPreview({ data }: { data: PayApplicationDocumentData }) {
  const PAGE_WIDTH = 816
  const PAGE_HEIGHT = 1056
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.7)

  useLayoutEffect(() => {
    const element = frameRef.current
    if (!element) return
    const update = () => setScale(Math.min(1, Math.max(0.3, element.clientWidth / PAGE_WIDTH)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={frameRef} className="mx-auto w-full max-w-[816px]">
      <div className="relative shadow-md" style={{ width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale }}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `scale(${scale})` }}>
          <PayApplicationDocument data={data} width={PAGE_WIDTH} height={PAGE_HEIGHT} />
        </div>
      </div>
    </div>
  )
}

function SendDialog({
  includesWaiver,
  open,
  onOpenChange,
  defaultRecipient,
  certificationRequired,
  amountCents,
  busy,
  onSend,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultRecipient: string
  includesWaiver: boolean
  certificationRequired: boolean
  amountCents: number
  busy: boolean
  onSend: (recipients: string[], message: string) => void
}) {
  const [recipients, setRecipients] = useState(defaultRecipient)
  const [message, setMessage] = useState("")
  useEffect(() => {
    if (open) setRecipients(defaultRecipient)
  }, [defaultRecipient, open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{certificationRequired ? "Send for certification" : "Send to the customer"}</DialogTitle>
          <DialogDescription>
            {certificationRequired
              ? `They receive the application and continuation sheet, and can certify ${moneyExact(amountCents)} or return it with comments. The invoice issues when they certify.${includesWaiver ? " Your signed waiver is included in the same email and portal." : ""}`
              : `The invoice for ${moneyExact(amountCents)} is issued and emailed, with the application${includesWaiver ? " and signed waiver" : ""} included in the same email.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="payapp-recipients" className="text-xs">
              Recipients
            </Label>
            <Input
              id="payapp-recipients"
              value={recipients}
              onChange={(event) => setRecipients(event.target.value)}
              placeholder="owner@example.com, architect@example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payapp-message" className="text-xs">
              Message <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="payapp-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              rows={3}
              placeholder="Anything the owner should know about this period."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSend(
                recipients
                  .split(/[,;\s]+/)
                  .map((value) => value.trim())
                  .filter(Boolean),
                message,
              )
            }
            disabled={busy || recipients.trim() === ""}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CertifyDialog({
  open,
  onOpenChange,
  amountCents,
  lines,
  busy,
  onCertify,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  amountCents: number
  lines: DeferrablePayApplicationLine[]
  busy: boolean
  onCertify: (input: InternalCertificateInput) => void
}) {
  const [signerName, setSignerName] = useState("")
  const [signatureText, setSignatureText] = useState("")
  const [note, setNote] = useState("")
  const [deferralDraft, setDeferralDraft] = useState<PayApplicationDeferralDraft>({})
  const certificate = resolvePayApplicationDeferrals(lines, deferralDraft, amountCents)
  useEffect(() => {
    if (!open) {
      setSignerName("")
      setSignatureText("")
      setNote("")
      setDeferralDraft({})
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Record the owner&apos;s certificate</DialogTitle>
          <DialogDescription>
            Record the certificate received outside Arc. The application requests {moneyExact(amountCents)}. Identify any amounts withheld from this certificate; these remain distinct from retainage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="certify-name" className="text-xs">
              Certified by
            </Label>
            <Input
              id="certify-name"
              value={signerName}
              onChange={(event) => setSignerName(event.target.value)}
              placeholder="Full name of the owner or architect"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="certify-signature" className="text-xs">
              Signature as given <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="certify-signature"
              value={signatureText}
              onChange={(event) => setSignatureText(event.target.value)}
              placeholder="As it appears on their certificate"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="certify-note" className="text-xs">
              Note <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="certify-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="Where the certificate came from, e.g. signed G702 received by email."
            />
          </div>
        </div>
        <PayApplicationDeferralEditor lines={lines} value={deferralDraft} onChange={setDeferralDraft} appliedCents={amountCents} disabled={busy} />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onCertify({ signerName: signerName.trim(), signatureText: signatureText.trim(), note: note.trim(), deferrals: certificate.deferrals })}
            disabled={busy || signerName.trim().length < 2 || Boolean(certificate.error)}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Record certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReturnDialog({
  open,
  onOpenChange,
  applicationNumber,
  busy,
  onReturn,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  applicationNumber: number
  busy: boolean
  onReturn: (reason: string) => void
}) {
  const [reason, setReason] = useState("")
  useEffect(() => {
    if (!open) setReason("")
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Return application #{applicationNumber} for revision</DialogTitle>
          <DialogDescription>
            The invoice is voided, the schedule of values reverses, and the application goes back to draft as the next
            revision. It keeps its number, so the sequence stays whole.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="return-reason" className="text-xs">
            Reason
          </Label>
          <Textarea
            id="return-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={3}
            placeholder="What the owner wants changed before they will certify."
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => onReturn(reason.trim())} disabled={busy || reason.trim().length < 3}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Return for revision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function downloadBase64(base64: string, fileName: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const blob = new Blob([bytes], { type: "application/pdf" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

function StoredMaterialsDialog({ line, endingCents, workCents, onApply, onClose }: {
  line: PayApplicationLine; endingCents: number; workCents: number
  onApply: (work: number, stored: number) => void; onClose: () => void
}) {
  const [added, setAdded] = useState("")
  const [installed, setInstalled] = useState("")
  const addedCents = centsFromField(added)
  const installedCents = centsFromField(installed)
  const valid = addedCents != null && installedCents != null && addedCents >= 0 && installedCents >= 0 && installedCents <= endingCents + addedCents
  const closing = endingCents + (addedCents ?? 0) - (installedCents ?? 0)
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent><DialogHeader>
    <DialogTitle>Stored materials · {line.description}</DialogTitle>
    <DialogDescription>New stored materials increase the request. Installing previously billed materials moves value into completed work without billing it twice.</DialogDescription>
  </DialogHeader>
    <dl className="flex justify-between text-sm"><dt>Prior application balance</dt><dd className="font-mono">{moneyExact(line.previous_stored_materials_cents)}</dd></dl>
    <dl className="flex justify-between text-sm"><dt>Current draft balance</dt><dd className="font-mono">{moneyExact(endingCents)}</dd></dl>
    <div className="space-y-2"><Label htmlFor="stored-added">Additional materials eligible for billing</Label><Input id="stored-added" inputMode="decimal" placeholder="0.00" value={added} onChange={(e) => setAdded(e.target.value)} /></div>
    <div className="space-y-2"><Label htmlFor="stored-installed">Move from stored to installed work</Label><Input id="stored-installed" inputMode="decimal" placeholder="0.00" value={installed} onChange={(e) => setInstalled(e.target.value)} /><p className="text-xs text-muted-foreground">Adds this amount to work this period. Do not also include it in your work entry.</p></div>
    <dl className="flex justify-between border-t pt-3 text-sm"><dt>Ending stored balance</dt><dd className="font-mono">{moneyExact(closing)}</dd></dl>
    {!valid ? <p role="alert" className="text-sm text-destructive">Enter nonnegative amounts. Installed materials cannot exceed the available stored balance.</p> : null}
    <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!valid} onClick={() => { const movement = applyStoredMaterialMovement({ workCents, storedCents: endingCents, addedCents: addedCents ?? 0, installedCents: installedCents ?? 0 }); onApply(movement.workCents, movement.storedCents) }}>Apply movements</Button></DialogFooter>
  </DialogContent></Dialog>
}

function ProgressEvidenceDialog({ evidence, projectId, onAccept, onClose }: {
  evidence: PayApplicationProgressEvidence; projectId: string; onAccept: () => void; onClose: () => void
}) {
  const [confirmed, setConfirmed] = useState(false)
  return <Dialog open onOpenChange={(open) => !open && onClose()}><DialogContent><DialogHeader>
    <DialogTitle>Review subcontract progress</DialogTitle><DialogDescription>{evidence.note}</DialogDescription>
  </DialogHeader>
    <dl className="grid grid-cols-2 gap-3 text-sm">
      <div><dt className="text-muted-foreground">Approved work to date</dt><dd className="mt-1 font-mono">{moneyExact(evidence.workCompletedCents)}</dd></div>
      <div><dt className="text-muted-foreground">Subcontract scheduled value</dt><dd className="mt-1 font-mono">{moneyExact(evidence.subcontractScheduledCents)}</dd></div>
      <div><dt className="text-muted-foreground">Subcontract stored balance</dt><dd className="mt-1 font-mono">{moneyExact(evidence.storedMaterialsCents)}</dd></div>
      <div><dt className="text-muted-foreground">Evidence through</dt><dd className="mt-1">{formatDay(evidence.throughDate)}</dd></div>
    </dl>
    <div className="text-sm"><p className="text-muted-foreground">Approved bills: {evidence.sourceBillNumbers.join(", ")}</p><div className="mt-2 flex flex-wrap gap-3">{evidence.sourceBillIds.map((id, index) => <a key={id} className="underline underline-offset-2" href={`/projects/${projectId}/financials/payables?bill=${id}`} target="_blank" rel="noopener noreferrer">Source bill {index + 1} ↗</a>)}</div></div>
    {evidence.suggestedPercentComplete != null ? <>
      <p className="border-t pt-3 text-sm">Use <strong className="font-mono">{evidence.suggestedPercentComplete}%</strong> as owner-side installed work complete. Arc calculates this period against previous billing. Stored materials remain unchanged.</p>
      <label className="flex items-start gap-2 text-sm"><Checkbox checked={confirmed} onCheckedChange={(checked) => setConfirmed(checked === true)} /><span>I verified this covers the owner SOV scope and agrees with field progress.</span></label>
    </> : null}
    <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button>{evidence.suggestedPercentComplete != null ? <Button disabled={!confirmed} onClick={onAccept}>Use reviewed progress</Button> : null}</DialogFooter>
  </DialogContent></Dialog>
}
