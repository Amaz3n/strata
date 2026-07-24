"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import type { Contact, CostCode, Invoice, InvoiceLienWaiver, InvoiceView, Payment, PaymentReversal, Project } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import {
  createInvoiceAction,
  getInvoiceDetailAction,
  manualResyncInvoiceAction,
  reviseInvoiceAction,
  updateInvoiceAction,
  voidInvoiceAction,
} from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { WorkspaceShell } from "@/components/financials/workspace/workspace-shell"
import { WorkspaceListPanel } from "@/components/financials/workspace/workspace-list-panel"
import { MakeRecurringDialog } from "@/components/invoices/invoice-schedules"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import { InvoiceEditableDocument, type AutosaveState } from "./workspace/invoice-editable-document"
import { InvoiceReadView } from "./workspace/invoice-read-view"
import { InvoiceContextPane } from "./workspace/invoice-context-pane"
import {
  customerNameOf,
  filterInvoices,
  invoiceNeedsAttention,
  invoiceQueueCounts,
  isEditableInvoice,
  type InvoiceQueue,
} from "./workspace/receivables-filters"
import { dueDateClassName, dueStateLabel, formatMoneyFromCents } from "./workspace/invoice-ui"

type DetailBundle = {
  invoice: Invoice
  link?: string
  views?: InvoiceView[]
  syncHistory?: Array<{ id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }>
  payments?: Payment[]
  reversals?: PaymentReversal[]
  lienWaivers?: InvoiceLienWaiver[]
}

interface ReceivablesWorkspaceProps {
  projectId: string
  projects: Project[]
  invoices: Invoice[]
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  contacts?: Contact[]
  costCodes?: CostCode[]
  enableApprovedCostsSource?: boolean
  /** Label shown while a source flow (e.g. a draw) is creating an invoice. */
  pendingLabel?: string
  onUpsertInvoice: (invoice: Invoice) => void
  onRemoveInvoice: (invoiceId: string) => void
  onRefresh: () => void
}

export function ReceivablesWorkspace({
  projectId,
  projects,
  invoices,
  builderInfo,
  contacts,
  costCodes,
  enableApprovedCostsSource,
  pendingLabel,
  onUpsertInvoice,
  onRemoveInvoice,
  onRefresh,
}: ReceivablesWorkspaceProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const selection = searchParams.get("invoice")
  const duplicateFromId = searchParams.get("duplicate")
  const sourceParam = searchParams.get("source")
  const initialSourceChangeOrderId = sourceParam?.startsWith("change_order:") ? sourceParam.slice("change_order:".length) : undefined

  const open = Boolean(selection) || Boolean(pendingLabel)

  const [search, setSearch] = useState("")
  const [queueFilter, setQueueFilter] = useState<InvoiceQueue>("all")
  const [autosaveState, setAutosaveState] = useState<AutosaveState>("idle")

  const [detail, setDetail] = useState<DetailBundle | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [duplicateSeed, setDuplicateSeed] = useState<Invoice | null>(null)

  // New-invoice session bookkeeping.
  const newNonceRef = useRef(0)
  const [newSession, setNewSession] = useState<{ nonce: number; draftId: string | null } | null>(null)
  const [reservation, setReservation] = useState<{ number: string; reservationId: string | null } | null>(null)

  const [recurringInvoice, setRecurringInvoice] = useState<Invoice | null>(null)
  const [voidingInvoice, setVoidingInvoice] = useState<Invoice | null>(null)
  const [destructiveLoading, setDestructiveLoading] = useState(false)

  const isNewSelection = selection === "new"
  const continuationId = newSession?.draftId
  const isContinuation = Boolean(selection && selection === continuationId)

  const setInvoiceParam = useCallback(
    (value: string | null, extra?: { duplicate?: string | null; source?: string | null }) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value) params.set("invoice", value)
      else params.delete("invoice")
      if (extra && "duplicate" in extra) {
        if (extra.duplicate) params.set("duplicate", extra.duplicate)
        else params.delete("duplicate")
      }
      if (extra && "source" in extra) {
        if (extra.source) params.set("source", extra.source)
        else params.delete("source")
      }
      const query = params.toString()
      router.replace(`${window.location.pathname}${query ? `?${query}` : ""}`, { scroll: false })
    },
    [router, searchParams],
  )

  // Start / tear down a new-invoice session as the ?invoice=new param appears.
  useEffect(() => {
    if (isNewSelection && (!newSession || newSession.draftId)) {
      newNonceRef.current += 1
      setNewSession({ nonce: newNonceRef.current, draftId: null })
      setDuplicateSeed(null)
      setAutosaveState("idle")
    }
    if (!selection && newSession) {
      setNewSession(null)
      setReservation(null)
    }
  }, [isNewSelection, selection, newSession])

  // Reserve an invoice number for a fresh new session; release it if the session ends unused.
  useEffect(() => {
    if (!newSession || newSession.draftId) return
    let cancelled = false
    fetch("/api/invoices/next-number", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload) return
        setReservation({ number: String(payload.number ?? ""), reservationId: payload.reservation_id ?? null })
      })
      .catch(() => null)
    return () => {
      cancelled = true
    }
  }, [newSession])

  const reservationIdForRelease = reservation?.reservationId ?? null
  useEffect(() => {
    // When a new session ends without producing a draft, release its reserved number.
    return () => {
      if (reservationIdForRelease && newSession && !newSession.draftId) {
        fetch("/api/invoices/release-reservation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reservation_id: reservationIdForRelease }),
        }).catch(() => null)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationIdForRelease])

  // Load full detail for an existing selected invoice (not the in-flight new-session draft).
  const loadDetail = useCallback(async (invoiceId: string) => {
    setDetailLoading(true)
    try {
      const result = unwrapAction(await getInvoiceDetailAction(invoiceId))
      setDetail(result)
      return result
    } catch (error) {
      toast.error("Could not load invoice", { description: error instanceof Error ? error.message : "Please try again." })
      return null
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selection || isNewSelection || isContinuation) return
    if (detail?.invoice.id === selection) return
    void loadDetail(selection)
  }, [selection, isNewSelection, isContinuation, detail?.invoice.id, loadDetail])

  // Fetch the duplicate source (full lines) when starting a duplicate.
  useEffect(() => {
    if (!isNewSelection || !duplicateFromId) {
      return
    }
    if (duplicateSeed?.id === duplicateFromId) return
    let cancelled = false
    getInvoiceDetailAction(duplicateFromId)
      .then((result) => {
        if (!cancelled) setDuplicateSeed(unwrapAction(result).invoice)
      })
      .catch(() => null)
    return () => {
      cancelled = true
    }
  }, [isNewSelection, duplicateFromId, duplicateSeed?.id])

  const filtered = useMemo(() => filterInvoices(invoices, { search, queue: queueFilter }), [invoices, search, queueFilter])
  const counts = useMemo(() => invoiceQueueCounts(invoices), [invoices])

  const close = useCallback(() => {
    setInvoiceParam(null, { duplicate: null, source: null })
    setDetail(null)
    setDuplicateSeed(null)
  }, [setInvoiceParam])

  const requestSelect = useCallback(
    (invoiceId: string | null) => {
      if (!invoiceId) {
        close()
        return
      }
      setInvoiceParam(invoiceId, { duplicate: null, source: null })
    },
    [close, setInvoiceParam],
  )

  const focusedCreateSession = isNewSelection || isContinuation

  // Keyboard triage j/k across the rail (not in focused create mode — there is no rail).
  useEffect(() => {
    if (!open || focusedCreateSession) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      const isTextEntry = tag === "input" || tag === "textarea" || target?.getAttribute("role") === "combobox"
      if (isTextEntry || event.metaKey || event.ctrlKey || event.altKey) return
      if ((event.key === "j" || event.key === "k") && selection) {
        const index = filtered.findIndex((invoice) => invoice.id === selection)
        const next = event.key === "j" ? filtered[index + 1] : filtered[index - 1]
        if (next) requestSelect(next.id)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, focusedCreateSession, filtered, selection, requestSelect])


  // ── Persistence callbacks handed to the editable document ──────────────────
  const handleCreateDraft = useCallback(
    async (input: InvoiceInput): Promise<Invoice> => {
      const created = unwrapAction(await createInvoiceAction(input))
      onUpsertInvoice(created)
      setNewSession((prev) => (prev ? { ...prev, draftId: created.id } : { nonce: newNonceRef.current, draftId: created.id }))
      setDetail({ invoice: created })
      setInvoiceParam(created.id, { duplicate: null, source: null })
      return created
    },
    [onUpsertInvoice, setInvoiceParam],
  )

  const handleAutosave = useCallback(
    async (invoiceId: string, input: InvoiceInput): Promise<Invoice> => {
      const updated = unwrapAction(await updateInvoiceAction(invoiceId, input))
      onUpsertInvoice(updated)
      setDetail((prev) => (prev && prev.invoice.id === updated.id ? { ...prev, invoice: updated } : prev))
      return updated
    },
    [onUpsertInvoice],
  )

  const handleSend = useCallback(
    async (invoiceId: string, input: InvoiceInput): Promise<Invoice> => {
      const sent = unwrapAction(await updateInvoiceAction(invoiceId, input))
      onUpsertInvoice(sent)
      setNewSession(null)
      setReservation(null)
      toast.success("Invoice sent")
      await loadDetail(invoiceId)
      onRefresh()
      return sent
    },
    [loadDetail, onRefresh, onUpsertInvoice],
  )

  const handleDuplicate = useCallback(() => {
    if (!detail?.invoice) return
    setDuplicateSeed(detail.invoice)
    setInvoiceParam("new", { duplicate: detail.invoice.id, source: null })
  }, [detail?.invoice, setInvoiceParam])

  const handleRevise = useCallback(async () => {
    if (!detail?.invoice) return
    setDestructiveLoading(true)
    try {
      const replacement = unwrapAction(await reviseInvoiceAction(detail.invoice.id))
      onUpsertInvoice({ ...detail.invoice, status: "void", client_visible: false, balance_due_cents: 0 })
      onUpsertInvoice(replacement)
      onRefresh()
      setInvoiceParam(replacement.id, { duplicate: null, source: null })
      toast.success("Replacement draft created", { description: `Invoice ${replacement.invoice_number} is ready for review.` })
    } catch (error) {
      toast.error("Could not revise invoice", { description: error instanceof Error ? error.message : "Please try again." })
    } finally {
      setDestructiveLoading(false)
    }
  }, [detail?.invoice, onRefresh, onUpsertInvoice, setInvoiceParam])

  const handleVoidConfirmed = useCallback(async () => {
    if (!voidingInvoice) return
    setDestructiveLoading(true)
    try {
      const updated = unwrapAction(await voidInvoiceAction(voidingInvoice.id))
      onUpsertInvoice(updated)
      setVoidingInvoice(null)
      onRefresh()
      close()
      toast.success("Invoice voided")
    } catch (error) {
      toast.error("Could not void invoice", { description: error instanceof Error ? error.message : "Please try again." })
    } finally {
      setDestructiveLoading(false)
    }
  }, [voidingInvoice, onUpsertInvoice, onRefresh, close])

  const handleCopyLink = useCallback(async () => {
    if (detail?.link && typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(detail.link)
      toast.success("Link copied")
    }
  }, [detail?.link])

  const handleResync = useCallback(async () => {
    if (!detail?.invoice) return
    try {
      unwrapAction(await manualResyncInvoiceAction(detail.invoice.id))
      toast.success("Resync enqueued")
      await loadDetail(detail.invoice.id)
    } catch (error) {
      toast.error("Failed to resync", { description: error instanceof Error ? error.message : "Please try again." })
    }
  }, [detail?.invoice, loadDetail])

  const project = projects.find((p) => p.id === projectId) ?? projects[0] ?? null
  const projectName = project?.name ?? null

  // ── Center pane routing ─────────────────────────────────────────────────────
  // A creation session (?invoice=new, incl. after autosave promotes it to ?invoice=<id>) renders
  // the focused create view — no queue rail, no context pane — until the user leaves it.
  const focusedCreate = focusedCreateSession
  const showEditable = focusedCreate || (detail?.invoice && isEditableInvoice(detail.invoice) && !detailLoading)
  const editableInitialInvoice = focusedCreate ? null : detail?.invoice ?? null
  const editKey = newSession ? `new:${newSession.nonce}` : selection ?? "none"

  const center = (() => {
    if (pendingLabel && !selection) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <p className="text-sm font-medium">Preparing invoice…</p>
          <p className="text-xs text-muted-foreground">{pendingLabel}</p>
        </div>
      )
    }
    if (showEditable) {
      return (
        <InvoiceEditableDocument
          key={editKey}
          initialInvoice={editableInitialInvoice}
          projectId={projectId}
          projects={projects}
          builderInfo={builderInfo}
          contacts={contacts}
          costCodes={costCodes}
          enableApprovedCostsSource={enableApprovedCostsSource}
          duplicateFrom={isNewSelection && duplicateSeed ? duplicateSeed : null}
          initialSourceChangeOrderId={isNewSelection ? initialSourceChangeOrderId : undefined}
          reservation={reservation}
          autosaveState={autosaveState}
          onCreateDraft={handleCreateDraft}
          onAutosave={handleAutosave}
          onSend={handleSend}
          onAutosaveStateChange={setAutosaveState}
        />
      )
    }
    if (detailLoading || !detail?.invoice) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )
    }
    return (
      <InvoiceReadView
        invoice={detail.invoice}
        link={detail.link}
        payments={detail.payments}
        lienWaivers={detail.lienWaivers}
        builderInfo={builderInfo}
        projectName={projectName}
        onBack={close}
        onCopyLink={handleCopyLink}
        onDuplicate={handleDuplicate}
        onMakeRecurring={() => setRecurringInvoice(detail.invoice)}
        onRevise={handleRevise}
        onVoid={() => setVoidingInvoice(detail.invoice)}
        onResync={handleResync}
        onChanged={async () => {
          await loadDetail(detail.invoice.id)
          onRefresh()
        }}
      />
    )
  })()

  const listPanel = (
    <WorkspaceListPanel<Invoice, InvoiceQueue>
      title="Receivables"
      onBack={close}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search invoice, customer…"
      queues={[
        { key: "all", label: "All", count: counts.all },
        { key: "draft", label: "Draft", count: counts.draft },
        { key: "outstanding", label: "Open", count: counts.outstanding },
        { key: "overdue", label: "Late", count: counts.overdue },
        { key: "attention", label: "Review", count: counts.attention },
        { key: "paid", label: "Paid", count: counts.paid },
      ]}
      activeQueue={queueFilter}
      onQueueChange={setQueueFilter}
      items={filtered}
      getKey={(invoice) => invoice.id}
      isActive={(invoice) => invoice.id === selection}
      onSelect={(invoice) => requestSelect(invoice.id)}
      emptyLabel="No invoices match."
      renderRow={(invoice) => (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-semibold">{invoice.invoice_number || invoice.title || "Untitled"}</span>
            <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMoneyFromCents(invoice.total_cents ?? invoice.totals?.total_cents ?? 0)}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="truncate text-muted-foreground">{customerNameOf(invoice) || "No customer"}</span>
            <span className={dueDateClassName(invoice)}>{dueStateLabel(invoice)}</span>
          </div>
          {invoiceNeedsAttention(invoice) ? (
            <AccountingSyncBadge status={invoice.qbo_sync_status} externalId={invoice.qbo_id ?? undefined} compact />
          ) : null}
        </>
      )}
    />
  )

  const documentPane = (
    <InvoiceContextPane
      projectId={projectId}
      invoice={isNewSelection && !newSession?.draftId ? null : detail?.invoice ?? null}
      link={detail?.link}
      views={detail?.views}
      syncHistory={detail?.syncHistory}
      payments={detail?.payments}
      loading={detailLoading}
    />
  )

  return (
    <>
      {open && focusedCreate ? (
        <Sheet open onOpenChange={(next) => { if (!next) close() }}>
          <SheetContent
            side="right"
            className="flex w-full flex-col gap-0 overflow-hidden border p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-5xl"
          >
            <SheetTitle className="sr-only">New invoice</SheetTitle>
            {center}
          </SheetContent>
        </Sheet>
      ) : (
        <WorkspaceShell open={open} onClose={close} listPanel={listPanel} documentPane={documentPane}>
          <div className="relative flex h-full flex-col">{center}</div>
        </WorkspaceShell>
      )}

      <MakeRecurringDialog invoice={recurringInvoice} open={Boolean(recurringInvoice)} onOpenChange={(o) => !o && setRecurringInvoice(null)} />

      <AlertDialog open={Boolean(voidingInvoice)} onOpenChange={(o) => !o && setVoidingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels {voidingInvoice?.invoice_number ?? "this invoice"} and releases any linked draws, change orders, or retainage so they can be billed again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={destructiveLoading} onClick={() => void handleVoidConfirmed()}>
              {destructiveLoading ? "Voiding…" : "Void invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
