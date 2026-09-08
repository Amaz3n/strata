"use client"

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangle, ChevronDown, ChevronRight, MoreHorizontal, Plus, Search, X } from "lucide-react"

import type { Contract, Invoice, Project } from "@/lib/types"
import type { PayApplication } from "@/lib/services/pay-applications"
import type { OwnerBillingPackageSummary } from "@/lib/services/owner-billing-packages"
import type { ProjectBillingSummary, ProjectBillingUpNext, UpNextRow } from "@/lib/services/billing-book"
import type { BillingManageSurface, BillingProfile, ReceivablesAccountingMode } from "@/lib/financials/billing-profile"
import { receivablesLabels } from "@/lib/financials/billing-profile"
import {
  deleteInvoiceAction,
  generateInvoiceLinkAction,
  issueInvoiceAction,
  listMovableProjectsAction,
  loadBillingRowsAction,
  manualResyncInvoiceAction,
  moveInvoiceToProjectAction,
  reviseInvoiceAction,
  sendInvoiceReminderAction,
  voidInvoiceAction,
} from "@/app/(app)/invoices/actions"
import {
  closeProjectBillingPeriodAction,
  createProjectFeeInvoiceAction,
  fetchProjectBillingBookAction,
  fetchPayApplicationsAction,
  generateOwnerBillingPackageAction,
  shareOwnerBillingPackageAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { generateInvoiceFromDrawAction } from "@/app/(app)/projects/[id]/actions"
import { unwrapAction } from "@/lib/action-result"
import { copyText } from "@/lib/clipboard"
import { newInvoiceHref, type NewInvoiceKind } from "@/lib/financials/invoice-destinations"
import { cn } from "@/lib/utils"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import { AccountingSyncSheet } from "@/components/integrations/accounting-sync-sheet"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Building2 } from "@/components/icons"

import { BillingManageSheets } from "./billing-manage-sheets"
import { PayApplicationWorkspace } from "@/components/financials/pay-application-workspace"
import { BillCostsWorkspace } from "./bill-costs-workspace"
import { InvoiceBottomBar, type InvoiceBulkActions } from "./invoice-bottom-bar"
import { InvoiceComposer, prefetchInvoiceComposer, type InvoiceComposerTarget } from "./invoice-composer"
import { InvoiceInspector } from "./invoice-inspector"
import { MakeRecurringDialog } from "./recurring-invoices"
import {
  InvoiceStatusBadge,
  NEXT_ACTION_TONES,
  balanceCentsOf,
  customerNameOf,
  displayStatusOf,
  formatMoneyCompact,
  formatMoneyFromCents,
  invoiceNeedsAttention,
  invoiceReleaseDescription,
  isEditableInvoice,
  isOpenInvoice,
  nextActionFor,
  totalCentsOf,
} from "./invoice-presentation"
import { invalidateInvoiceDetail, useHoverPrefetch, useInvoiceDetail } from "./use-invoice-detail-cache"

/**
 * The billing book: one table, three bands, in the order a bookkeeper asks the
 * questions. UP NEXT is what has to go out — planned billing events the
 * project's contract implies (a due draw, a period of approved costs, a pay
 * application to start, retainage to release) alongside the drafts already in
 * hand. OPEN is who still owes money. HISTORY is the record.
 *
 * The bands are the filter. The old page had eight queue chips whose counts
 * cost eight queries each, four money tiles and a four-bucket aging strip
 * before the first row; all of that answered questions the row position and
 * the status column already answer, or belong to the reports.
 */

const HISTORY_PAGE = 50

type BandKey = "up_next" | "open" | "history"

export interface BillingBookProps {
  scope: { kind: "org" } | { kind: "project"; projectId: string }
  /** One on a project workbench; every project on the org desk. */
  projects: Project[]
  profile: BillingProfile
  accounting: ReceivablesAccountingMode
  /** Project-specific presentation for mixed-posture, mixed-accounting org desks. */
  projectProfiles?: Record<string, BillingProfile>
  accountingByProject?: Record<string, ReceivablesAccountingMode>
  contract?: Contract | null
  initialRows: Invoice[]
  initialTotalCount: number
  initialSummary: ProjectBillingSummary
  initialUpNext?: ProjectBillingUpNext | null
  selectedPeriodId?: string | null
  costCodesEnabled?: boolean
  ownerBillingPackages?: OwnerBillingPackageSummary[]
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  loadErrors?: string[]
}

export function BillingBook({
  scope,
  projects,
  profile,
  accounting,
  projectProfiles = {},
  accountingByProject = {},
  contract = null,
  initialRows,
  initialTotalCount,
  initialSummary,
  initialUpNext = null,
  selectedPeriodId: initialPeriodId = null,
  costCodesEnabled = true,
  ownerBillingPackages = [],
  builderInfo,
  loadErrors = [],
}: BillingBookProps) {
  const projectId = scope.kind === "project" ? scope.projectId : undefined
  const router = useRouter()
  const labels = receivablesLabels(accounting)
  const portfolioShowsExternalSync = labels.showExternalSync || Object.values(accountingByProject).some(
    (mode) => receivablesLabels(mode).showExternalSync,
  )
  const [selectedId, selectInvoice] = useWorkspaceParam("invoice")
  const [composeParam, setComposeParam] = useWorkspaceParam("compose")
  const searchParams = useSearchParams()
  // The extras that shape a NEW composition ride beside `compose` in the URL,
  // so a link can say "duplicate this" or "start a deposit" and Back still works.
  const composeTarget = useMemo<InvoiceComposerTarget | null>(() => {
    if (!composeParam) return null
    const kind = searchParams.get("kind")
    const source = searchParams.get("source")
    return {
      compose: composeParam,
      duplicateOf: searchParams.get("duplicate"),
      sourceChangeOrderId: source?.startsWith("change_order:") ? source.slice("change_order:".length) : null,
      customerId: searchParams.get("customer"),
      kind: kind === "earnest_deposit" || kind === "closing" ? (kind as NewInvoiceKind) : null,
    }
  }, [composeParam, searchParams])

  /** Open the composer in place. Extras are written to the URL first so the param hook sees a complete address. */
  const openCompose = useCallback(
    (target: { draftId?: string; duplicateOf?: string; kind?: NewInvoiceKind; customerId?: string }) => {
      const params = new URLSearchParams(window.location.search)
      for (const key of ["duplicate", "source", "customer", "kind"]) params.delete(key)
      if (target.duplicateOf) params.set("duplicate", target.duplicateOf)
      if (target.kind && target.kind !== "standard") params.set("kind", target.kind)
      if (target.customerId) params.set("customer", target.customerId)
      const query = params.toString()
      window.history.replaceState(window.history.state, "", query ? `${window.location.pathname}?${query}` : window.location.pathname)
      setComposeParam(target.draftId ?? "new")
    },
    [setComposeParam],
  )
  const closeCompose = useCallback(() => {
    const params = new URLSearchParams(window.location.search)
    for (const key of ["duplicate", "source", "customer", "kind"]) params.delete(key)
    const query = params.toString()
    window.history.replaceState(window.history.state, "", query ? `${window.location.pathname}?${query}` : window.location.pathname)
    setComposeParam(null)
  }, [setComposeParam])
  const [manageParam, setManageParam] = useWorkspaceParam("manage")
  const manageSurface = isManageSurface(manageParam) ? manageParam : null

  const [rows, setRows] = useState<Invoice[]>(initialRows)
  const [activeTotal, setActiveTotal] = useState(initialTotalCount)
  const [summary, setSummary] = useState(initialSummary)
  const [upNext, setUpNext] = useState<ProjectBillingUpNext | null>(initialUpNext)
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(initialPeriodId ?? initialUpNext?.selectedPeriod?.id ?? null)
  const [search, setSearch] = useState("")
  const [loadingRows, setLoadingRows] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [bookErrors, setBookErrors] = useState<string[]>(initialUpNext?.errors ?? [])

  const [history, setHistory] = useState<{ rows: Invoice[]; total: number; loaded: boolean; loading: boolean }>({
    rows: [],
    total: initialSummary.bands.paid + initialSummary.bands.void,
    loaded: false,
    loading: false,
  })
  const [historyOpen, setHistoryOpen] = useState(false)
  const [upNextOpen, setUpNextOpen] = useState(true)
  const [openOpen, setOpenOpen] = useState(true)

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkBusy, setBulkBusy] = useState<"send" | "remind" | "void" | "delete" | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState<"void" | "delete" | null>(null)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  const [plannedBusyKey, setPlannedBusyKey] = useState<string | null>(null)
  const [destructiveBusy, setDestructiveBusy] = useState(false)
  const [autoPaymentFor, setAutoPaymentFor] = useState<string | null>(null)

  const [syncQueueOpen, setSyncQueueOpen] = useState(false)
  const [recurringInvoice, setRecurringInvoice] = useState<Invoice | null>(null)
  const [voidingInvoice, setVoidingInvoice] = useState<Invoice | null>(null)
  const [revisingInvoice, setRevisingInvoice] = useState<Invoice | null>(null)
  const [deletingInvoice, setDeletingInvoice] = useState<Invoice | null>(null)
  const [movingInvoice, setMovingInvoice] = useState<Invoice | null>(null)
  const [billRow, setBillRow] = useState<UpNextRow | null>(null)
  // The pay-application workspace is a takeover, like the composer, so it is
  // addressable and closes with Back rather than stacking inside a sheet.
  const [payAppParam, setPayAppParam] = useWorkspaceParam("payapp")
  const [applications, setApplications] = useState<PayApplication[]>([])
  const [applicationError, setApplicationError] = useState<string | null>(null)
  const reloadApplications = useCallback(async () => {
    if (!projectId || !profile.progressBilling) return
    try {
      setApplications(unwrapAction(await fetchPayApplicationsAction(projectId)))
      setApplicationError(null)
    } catch (error) {
      setApplicationError(error instanceof Error ? error.message : "Application status could not load.")
    }
  }, [projectId, profile.progressBilling])
  useEffect(() => { void reloadApplications() }, [reloadApplications])
  const applicationByInvoice = useMemo(() => new Map(applications.filter((app) => app.invoice_id).map((app) => [app.invoice_id!, app])), [applications])
  const [newInvoiceProjectOpen, setNewInvoiceProjectOpen] = useState(false)
  const [packages, setPackages] = useState<OwnerBillingPackageSummary[]>(ownerBillingPackages)
  const [, startTransition] = useTransition()

  const scopedProject = projects.length === 1 ? projects[0] : null
  const effectiveProjectId = projectId ?? scopedProject?.id
  const releaseDescription = scope.kind === "org"
    ? "linked billing sources or retainage"
    : invoiceReleaseDescription(profile.costDriven)
  const contractTotalCents = contract?.total_cents ?? 0
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setRows(initialRows)
    setActiveTotal(initialTotalCount)
    setSummary(initialSummary)
    setUpNext(initialUpNext)
    setBookErrors(initialUpNext?.errors ?? [])
  }, [initialRows, initialTotalCount, initialSummary, initialUpNext])

  useEffect(() => {
    setPackages(ownerBillingPackages)
  }, [ownerBillingPackages])

  // ── Rows ──────────────────────────────────────────────────────────────────
  const allRows = useMemo(() => (history.loaded ? [...rows, ...history.rows] : rows), [rows, history])
  const { detail, loading: detailLoading, error: detailError, refresh: refreshDetail } = useInvoiceDetail(selectedId, allRows)
  const hover = useHoverPrefetch()

  const requestSeq = useRef(0)
  const reloadBook = useCallback(
    async (opts?: { silent?: boolean; periodId?: string | null }) => {
      const seq = ++requestSeq.current
      const term = search.trim() || undefined
      if (!opts?.silent) setLoadingRows(true)
      try {
        if (projectId) {
          const result = unwrapAction(
            await fetchProjectBillingBookAction({
              projectId,
              profile,
              selectedPeriodId: opts?.periodId === undefined ? selectedPeriodId : opts.periodId,
              contractTotalCents,
              search: term,
            }),
          )
          if (seq !== requestSeq.current) return
          setRows(result.rows.invoices)
          setActiveTotal(result.rows.totalCount)
          setSummary(result.summary)
          setUpNext(result.upNext)
          setBookErrors(result.upNext.errors)
        } else {
          const result = unwrapAction(await loadBillingRowsAction(undefined, { queue: "active", search: term }))
          if (seq !== requestSeq.current) return
          setRows(result.invoices)
          setActiveTotal(result.totalCount)
        }
        setListError(null)
      } catch (error) {
        if (seq !== requestSeq.current) return
        setListError(error instanceof Error ? error.message : "The invoice list could not be loaded.")
      } finally {
        if (seq === requestSeq.current) setLoadingRows(false)
      }
    },
    [contractTotalCents, profile, projectId, search, selectedPeriodId],
  )

  const loadHistory = useCallback(
    async (opts?: { more?: boolean }) => {
      setHistory((current) => ({ ...current, loading: true }))
      try {
        const result = unwrapAction(
          await loadBillingRowsAction(effectiveProjectId, {
            queue: "history",
            search: search.trim() || undefined,
            offset: opts?.more ? history.rows.length : 0,
            limit: HISTORY_PAGE,
          }),
        )
        setHistory((current) => {
          const known = new Set(opts?.more ? current.rows.map((row) => row.id) : [])
          const merged = opts?.more
            ? [...current.rows, ...result.invoices.filter((row) => !known.has(row.id))]
            : result.invoices
          return { rows: merged, total: result.totalCount, loaded: true, loading: false }
        })
      } catch (error) {
        setHistory((current) => ({ ...current, loading: false }))
        toast.error("Could not load settled invoices", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    },
    [effectiveProjectId, history.rows.length, search],
  )

  // Search re-reads both bands from the server; a search that only combed the
  // loaded page would miss last year's invoice, which is the one being looked for.
  const firstRender = useRef(true)
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const handle = setTimeout(() => {
      void reloadBook()
      if (search.trim()) {
        setHistoryOpen(true)
        void loadHistory()
      } else if (history.loaded) {
        void loadHistory()
      }
    }, 250)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  useEffect(() => {
    if (historyOpen && !history.loaded && !history.loading) void loadHistory()
  }, [historyOpen, history.loaded, history.loading, loadHistory])

  /** Everything a mutation may have moved: rows, numbers, the open invoice. */
  const refreshAll = useCallback(
    async (invoiceId?: string | null) => {
      invalidateInvoiceDetail(invoiceId ?? undefined)
      await Promise.all([reloadBook({ silent: true }), reloadApplications(), history.loaded ? loadHistory() : Promise.resolve()])
      if (selectedId) await refreshDetail()
      if (!projectId) startTransition(() => router.refresh())
    },
    [history.loaded, loadHistory, projectId, refreshDetail, reloadBook, reloadApplications, router, selectedId],
  )

  const placeInvoice = useCallback(
    (invoice: Invoice) => {
      setRows((current) => [invoice, ...current.filter((row) => row.id !== invoice.id)])
      selectInvoice(invoice.id)
    },
    [selectInvoice],
  )

  // ── Bands ─────────────────────────────────────────────────────────────────
  const drafts = useMemo(
    () =>
      rows
        .filter((invoice) => displayStatusOf(invoice) === "draft" && !(upNext?.rows.some((row) => row.payApplicationId && row.payApplicationId === invoice.metadata?.source_pay_application_id)))
        .sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""))),
    [rows, upNext],
  )
  const openRows = useMemo(
    () =>
      rows
        .filter((invoice) => displayStatusOf(invoice) !== "draft")
        .sort((left, right) => {
          const leftDue = left.due_date ?? "9999-12-31"
          const rightDue = right.due_date ?? "9999-12-31"
          return leftDue.localeCompare(rightDue)
        }),
    [rows],
  )
  const plannedRows = upNext?.rows ?? []
  const upNextCount = plannedRows.length + drafts.length
  const openBalanceCents = useMemo(() => openRows.reduce((sum, invoice) => sum + balanceCentsOf(invoice), 0), [openRows])

  // The keyboard walks invoice rows in reading order: drafts, open, then history.
  const orderedInvoices = useMemo(
    () => [...(upNextOpen ? drafts : []), ...(openOpen ? openRows : []), ...(historyOpen ? history.rows : [])],
    [drafts, history.rows, historyOpen, openOpen, openRows, upNextOpen],
  )

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (target && (target.closest("input, textarea, select, [contenteditable='true']") || target.closest("[role='dialog']"))) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "/") {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (event.key === "Escape" && selectedId) {
        selectInvoice(null)
        return
      }
      if (event.key !== "j" && event.key !== "k") return
      if (orderedInvoices.length === 0) return
      event.preventDefault()
      const index = orderedInvoices.findIndex((invoice) => invoice.id === selectedId)
      const nextIndex =
        event.key === "j"
          ? Math.min(orderedInvoices.length - 1, index + 1)
          : Math.max(0, index < 0 ? 0 : index - 1)
      selectInvoice(orderedInvoices[nextIndex].id)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [orderedInvoices, selectInvoice, selectedId])

  // ── Invoice row actions ───────────────────────────────────────────────────
  async function runRowAction(invoice: Invoice, key: string, fn: () => Promise<void>) {
    setRowBusyId(`${invoice.id}:${key}`)
    try {
      await fn()
    } finally {
      setRowBusyId(null)
    }
  }

  const handleIssue = (invoice: Invoice) =>
    runRowAction(invoice, "issue", async () => {
      try {
        unwrapAction(await issueInvoiceAction(invoice.id))
        toast.success(`Invoice ${invoice.invoice_number} issued`)
        await refreshAll(invoice.id)
      } catch (error) {
        toast.error("Could not issue the invoice", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleReminder = (invoice: Invoice) =>
    runRowAction(invoice, "reminder", async () => {
      try {
        unwrapAction(await sendInvoiceReminderAction(invoice.id))
        toast.success("Reminder sent", { description: `Invoice ${invoice.invoice_number}` })
        await refreshAll(invoice.id)
      } catch (error) {
        toast.error("Could not send the reminder", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleCopyLink = (invoice: Invoice) =>
    runRowAction(invoice, "link", async () => {
      try {
        const result = unwrapAction(await generateInvoiceLinkAction(invoice.id))
        const copied = await copyText(result.url)
        toast.success(copied ? `${profile.customerLabel} link copied` : `${profile.customerLabel} link ready`, {
          description: result.url,
        })
      } catch (error) {
        toast.error("Could not create the link", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  async function handleVoid() {
    if (!voidingInvoice) return
    setDestructiveBusy(true)
    try {
      unwrapAction(await voidInvoiceAction(voidingInvoice.id))
      toast.success("Invoice voided")
      setVoidingInvoice(null)
      await refreshAll(voidingInvoice.id)
    } catch (error) {
      toast.error("Could not void the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setDestructiveBusy(false)
    }
  }

  async function handleRevise() {
    if (!revisingInvoice) return
    setDestructiveBusy(true)
    try {
      const replacement = unwrapAction(await reviseInvoiceAction(revisingInvoice.id))
      setRevisingInvoice(null)
      toast.success("Replacement draft created", { description: `Invoice ${replacement.invoice_number} is ready.` })
      placeInvoice(replacement)
      await refreshAll(revisingInvoice.id)
    } catch (error) {
      toast.error("Could not revise the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setDestructiveBusy(false)
    }
  }

  async function handleDelete() {
    if (!deletingInvoice) return
    setDestructiveBusy(true)
    try {
      unwrapAction(await deleteInvoiceAction(deletingInvoice.id))
      if (selectedId === deletingInvoice.id) selectInvoice(null)
      setDeletingInvoice(null)
      toast.success("Draft deleted")
      await refreshAll(deletingInvoice.id)
    } catch (error) {
      toast.error("Could not delete the draft", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setDestructiveBusy(false)
    }
  }

  const selectedInvoices = useMemo(() => allRows.filter((invoice) => selectedIds.includes(invoice.id)), [allRows, selectedIds])
  const bulk = useMemo<InvoiceBulkActions>(
    () => ({
      sendable: selectedInvoices.filter((invoice) => nextActionFor(invoice).key === "issue").length,
      remindable: selectedInvoices.filter((invoice) => isOpenInvoice(invoice)).length,
      voidable: selectedInvoices.filter((invoice) => {
        const status = displayStatusOf(invoice)
        return Boolean(invoice.sent_at) && !["paid", "partial", "void", "draft"].includes(status)
      }).length,
      deletable: selectedInvoices.filter((invoice) => isEditableInvoice(invoice)).length,
    }),
    [selectedInvoices],
  )

  /** Run one action over the selection, reporting every row and continuing past failures. */
  async function runBulk(
    key: NonNullable<typeof bulkBusy>,
    targets: Invoice[],
    act: (invoice: Invoice) => Promise<unknown>,
    verb: string,
  ) {
    if (targets.length === 0) return
    setBulkBusy(key)
    let done = 0
    const failures: string[] = []
    for (const invoice of targets) {
      try {
        await act(invoice)
        done += 1
      } catch {
        failures.push(invoice.invoice_number ?? invoice.id)
      }
    }
    setBulkBusy(null)
    if (done > 0) toast.success(`${verb} ${done} invoice${done === 1 ? "" : "s"}`)
    if (failures.length > 0) toast.error(`${failures.length} could not be ${verb.toLowerCase()}`, { description: failures.join(", ") })
    if (failures.length === 0) setSelectedIds([])
    await refreshAll()
  }

  const handleBulkSend = () =>
    runBulk(
      "send",
      selectedInvoices.filter((invoice) => nextActionFor(invoice).key === "issue"),
      async (invoice) => unwrapAction(await issueInvoiceAction(invoice.id)),
      "Sent",
    )
  const handleBulkReminders = () =>
    runBulk(
      "remind",
      selectedInvoices.filter((invoice) => isOpenInvoice(invoice)),
      async (invoice) => unwrapAction(await sendInvoiceReminderAction(invoice.id)),
      "Reminded",
    )
  const handleBulkVoid = () =>
    runBulk(
      "void",
      selectedInvoices.filter((invoice) => {
        const status = displayStatusOf(invoice)
        return Boolean(invoice.sent_at) && !["paid", "partial", "void", "draft"].includes(status)
      }),
      async (invoice) => unwrapAction(await voidInvoiceAction(invoice.id)),
      "Voided",
    )
  const handleBulkDelete = () =>
    runBulk(
      "delete",
      selectedInvoices.filter((invoice) => isEditableInvoice(invoice)),
      async (invoice) => {
        unwrapAction(await deleteInvoiceAction(invoice.id))
        if (selectedId === invoice.id) selectInvoice(null)
      },
      "Deleted",
    )

  function handleExportCsv() {
    const exportRows = selectedIds.length > 0 ? allRows.filter((row) => selectedIds.includes(row.id)) : allRows
    if (exportRows.length === 0) return
    const escape = (value: string | number) => {
      // Neutralize spreadsheet formula injection (=, +, -, @ leads) before CSV quoting.
      const raw = String(value)
      const str = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
    }
    const header = ["Invoice No.", "Billed to", "Status", "Next action", "Due date", "Total", "Balance"]
    const lines = exportRows.map((invoice) =>
      [
        invoice.invoice_number ?? "",
        customerNameOf(invoice),
        displayStatusOf(invoice),
        nextActionFor(invoice).label,
        invoice.due_date ?? "",
        (totalCentsOf(invoice) / 100).toFixed(2),
        (balanceCentsOf(invoice) / 100).toFixed(2),
      ]
        .map(escape)
        .join(","),
    )
    const csv = [header.map(escape).join(","), ...lines].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `invoices-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${exportRows.length} invoice${exportRows.length === 1 ? "" : "s"}`)
  }

  // ── Planned row actions ───────────────────────────────────────────────────
  async function runPlanned(row: UpNextRow, fn: () => Promise<void>) {
    setPlannedBusyKey(row.key)
    try {
      await fn()
    } catch (error) {
      toast.error("That didn't go through", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setPlannedBusyKey(null)
    }
  }

  function handlePlanned(row: UpNextRow) {
    if (row.href) {
      router.push(row.href)
      return
    }
    if (!projectId) return
    switch (row.kind) {
      case "draw":
        void runPlanned(row, async () => {
          const result = unwrapAction(await generateInvoiceFromDrawAction(projectId, row.drawId as string))
          toast.success("Draft invoice created", { description: `Invoice ${result.invoice_number}` })
          placeInvoice(result.invoice)
          await refreshAll()
        })
        return
      case "period_bill":
        if (row.actionLabel === "Review costs") {
          router.push(`/projects/${projectId}/financials/cost-inbox`)
          return
        }
        setBillRow(row)
        return
      case "period_close":
        void runPlanned(row, async () => {
          unwrapAction(
            await closeProjectBillingPeriodAction({ projectId, billingPeriodId: row.billingPeriodId as string }),
          )
          toast.success("Billing period closed")
          await refreshAll()
        })
        return
      case "fee":
        void runPlanned(row, async () => {
          const result = unwrapAction(await createProjectFeeInvoiceAction({ projectId, issue: false }))
          toast.success("Fee invoice created")
          placeInvoice(result.invoice)
          await refreshAll()
        })
        return
      case "pay_app":
        setPayAppParam(row.payApplicationId ?? "new")
        return
      case "pay_app_new":
        setPayAppParam("new")
        return
      case "retainage":
        setManageParam("retainage")
        return
      case "deposit":
        openCompose({ kind: "earnest_deposit" })
        return
      case "closing":
        router.push(`/projects/${projectId}/closeout`)
        return
    }
  }

  function changePeriod(periodId: string | null) {
    setSelectedPeriodId(periodId)
    const params = new URLSearchParams(window.location.search)
    if (periodId) params.set("period", periodId)
    else params.delete("period")
    const query = params.toString()
    window.history.replaceState(window.history.state, "", query ? `${window.location.pathname}?${query}` : window.location.pathname)
    void reloadBook({ silent: true, periodId })
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const packageByInvoice = useMemo(() => new Map(packages.map((entry) => [entry.invoice_id, entry])), [packages])
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const profileForInvoice = useCallback(
    (invoice: Invoice) => invoice.project_id ? projectProfiles[invoice.project_id] ?? profile : profile,
    [profile, projectProfiles],
  )
  const accountingForInvoice = useCallback(
    (invoice: Invoice | null | undefined) => invoice?.project_id ? accountingByProject[invoice.project_id] ?? accounting : accounting,
    [accounting, accountingByProject],
  )
  const allVisibleSelected = orderedInvoices.length > 0 && orderedInvoices.every((row) => selectedIds.includes(row.id))
  const someVisibleSelected = orderedInvoices.some((row) => selectedIds.includes(row.id)) && !allVisibleSelected
  // Checkboxes are always there: selecting is not a mode.
  const showSelection = true
  const compact = Boolean(selectedId)
  // A project has one customer; naming them on every row is a column of the
  // same words. The org desk reads across customers, so it keeps the column —
  // until the inspector opens and the table has to give up the space.
  const showClient = !projectId && !compact
  // The memo is what the invoice is for, in the words it was written with —
  // the title, or the first line of the notes. The number alone says nothing.
  const showMemo = !compact
  const syncPending = rows.filter((row) => row.qbo_sync_status === "pending").length
  const syncAttention = rows.filter((row) => invoiceNeedsAttention(row)).length
  const newHref = effectiveProjectId ? newInvoiceHref(effectiveProjectId) : null
  const warmComposer = () => {
    if (projectId) prefetchInvoiceComposer(projectId)
  }
  const selectedRow = selectedId ? allRows.find((row) => row.id === selectedId) ?? null : null
  const warnings = [...loadErrors, ...bookErrors]
  // With the inspector open the table gives up ~500px, so the two columns the
  // panel repeats (amount, customer) fold away; the customer moves under the number.
  const columnCount = 6 + (showClient ? 1 : 0) + (showMemo ? 1 : 0) + (showSelection ? 1 : 0) - (compact ? 1 : 0) - (scope.kind === "org" ? 1 : 0)

  function openManage(surface: BillingManageSurface) {
    setManageParam(surface)
  }

  const primaryButton = (() => {
    if (profile.primaryAction.kind === "new_pay_application" && projectId) {
      return (
        <div className="flex items-stretch">
          <Button
            size="sm"
            className="h-9 rounded-r-none"
            onClick={() => setPayAppParam("new")}
          >
            <Plus className="mr-2 h-4 w-4" />
            {profile.primaryAction.label}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="h-9 rounded-l-none border-l border-primary-foreground/20 px-2" aria-label="More ways to bill">
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {projectId ? (
                <DropdownMenuItem onSelect={() => openCompose({})} onPointerEnter={warmComposer}>
                  New invoice
                </DropdownMenuItem>
              ) : newHref ? (
                <DropdownMenuItem asChild>
                  <Link href={newHref}>New invoice</Link>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    }
    if (projectId) {
      return (
        <Button
          size="sm"
          className="h-9 whitespace-nowrap"
          onClick={() => openCompose({})}
          onPointerEnter={warmComposer}
          onFocus={warmComposer}
        >
          <Plus className="mr-2 h-4 w-4" />
          {profile.primaryAction.label}
        </Button>
      )
    }
    if (newHref) {
      return (
        <Button size="sm" className="h-9 whitespace-nowrap" asChild>
          <Link href={newHref}>
            <Plus className="mr-2 h-4 w-4" />
            {profile.primaryAction.label}
          </Link>
        </Button>
      )
    }
    return (
      <Button size="sm" className="h-9" onClick={() => setNewInvoiceProjectOpen(true)}>
        <Plus className="mr-2 h-4 w-4" />
        New invoice
      </Button>
    )
  })()

  return (
    <div className="flex h-[calc(100svh-3.5rem)] w-full flex-col">
      {/* Toolbar: the numbers that matter, then search and the one way to bill. */}
      <div className="shrink-0 border-b bg-background">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <SummaryLine summary={summary} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={`Search number or ${profile.customerLabel.toLowerCase()}`}
                aria-label="Search invoices"
                className="h-9 bg-muted/30 pl-9 pr-8 shadow-none transition-colors focus-visible:bg-background"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            {primaryButton}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9 shrink-0 bg-background" aria-label="Billing tools">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                {projectId && profile.manageSurfaces.length > 0 ? (
                  <>
                    <DropdownMenuLabel className="microlabel">Billing tools</DropdownMenuLabel>
                    {profile.manageSurfaces.includes("draws") ? (
                      <DropdownMenuItem onSelect={() => openManage("draws")}>Draw schedule…</DropdownMenuItem>
                    ) : null}
                    {profile.manageSurfaces.includes("sov") ? (
                      <DropdownMenuItem onSelect={() => openManage("sov")}>Schedule of values…</DropdownMenuItem>
                    ) : null}
                    {profile.manageSurfaces.includes("retainage") ? (
                      <DropdownMenuItem onSelect={() => openManage("retainage")}>Retainage ledger…</DropdownMenuItem>
                    ) : null}
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                {projectId ? <DropdownMenuItem onSelect={() => openManage("recurring")}>Recurring invoices…</DropdownMenuItem> : null}
                {portfolioShowsExternalSync ? (
                  <DropdownMenuItem onSelect={() => setSyncQueueOpen(true)}>
                    Accounting sync queue
                    {syncPending + syncAttention > 0 ? (
                      <span
                        className={cn(
                          "ml-auto font-mono text-xs tabular-nums",
                          syncAttention > 0 ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {syncPending + syncAttention}
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {applicationError ? <div role="alert" className="flex items-center gap-3 border-b px-4 py-2 text-sm text-destructive"><span>Application status unavailable: {applicationError}</span><Button size="sm" variant="outline" onClick={() => void reloadApplications()}>Retry</Button></div> : null}
      {warnings.length > 0 ? (
        <div className="flex items-start gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2.5 text-sm sm:px-6 lg:px-8">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">Some billing data could not load — what you see below is incomplete.</span>
            <span className="text-muted-foreground">{warnings.join(" · ")}</span>
          </div>
        </div>
      ) : null}

      {/*
        The inspector is a panel in the flow, not a layer over it: selecting an
        invoice narrows the table and the detail takes the space it gave up.
        Selection lives in the URL through history.replaceState, so it never
        re-renders the page on the server.
      */}
      <div className="flex min-h-0 w-full flex-1 flex-col lg:flex-row">
        {/*
          The table scrolls in its own container and the inspector in its own, so
          neither ever asks the page to scroll to reveal the other's bottom.
        */}
        <div className={cn("min-h-0 min-w-0 flex-1 flex-col", selectedId ? "hidden lg:flex" : "flex")}>
          {listError ? (
            <div className="m-4 border border-destructive/30 bg-destructive/10 p-4 text-sm">
              <p className="font-medium">The invoice list could not be loaded.</p>
              <p className="mt-1 text-muted-foreground">{listError}</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={() => void reloadBook()}>
                Try again
              </Button>
            </div>
          ) : (
            <Table
              containerClassName="min-h-0 flex-1 overflow-auto"
              className={cn(loadingRows && "pointer-events-none opacity-60 transition-opacity")}
            >
              <TableHeader className="sticky top-0 z-20 bg-background">
                <TableRow>
                  {showSelection ? (
                    <TableHead className="w-10 px-3">
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                        onCheckedChange={(checked) => setSelectedIds(checked ? orderedInvoices.map((row) => row.id) : [])}
                        aria-label="Select every visible invoice"
                      />
                    </TableHead>
                  ) : null}
                  <TableHead className="px-4 py-2.5">{profile.progressBilling ? "Application / invoice" : "Invoice"}</TableHead>
                  {showClient ? <TableHead className="px-4 py-2.5">{profile.customerLabel}</TableHead> : null}
                  {showMemo ? <TableHead className="px-4 py-2.5">Memo</TableHead> : null}
                  {compact ? null : <TableHead className="px-4 py-2.5 text-right">Amount</TableHead>}
                  <TableHead className="px-4 py-2.5 text-right">Balance</TableHead>
                  <TableHead className="px-4 py-2.5">Status</TableHead>
                  {projectId ? <TableHead className="px-4 py-2.5">Next</TableHead> : null}
                  <TableHead
                    className={cn(
                      "px-4 py-2.5 text-right",
                      projectId ? (compact ? "w-28" : "w-36") : "w-10",
                    )}
                  >
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* ── Up next ── */}
                <BandHeader
                  colSpan={columnCount}
                  title="Up next"
                  count={upNextCount}
                  open={upNextOpen}
                  onToggle={() => setUpNextOpen((value) => !value)}
                  trailing={
                    upNext && upNext.periods.length > 0 ? (
                      <PeriodPicker
                        periods={upNext.periods}
                        selectedId={selectedPeriodId}
                        onChange={changePeriod}
                      />
                    ) : null
                  }
                />
                {upNextOpen ? (
                  upNextCount === 0 ? (
                    <EmptyBand
                      colSpan={columnCount}
                      title={search.trim() ? "No drafts match" : "Nothing to send"}
                      body={
                        search.trim()
                          ? "Drafts matching your search would show here."
                          : projectId
                            ? "Planned billing and drafts wait here until they go out."
                            : "Drafts across every project wait here until they go out."
                      }
                    />
                  ) : (
                    <>
                      {plannedRows.map((row) => (
                        <PlannedRow
                          key={row.key}
                          row={row}
                          showSelection={showSelection}
                          showClient={showClient}
                          showMemo={showMemo}
                          compact={compact}
                          showNextAction={Boolean(projectId)}
                          busy={plannedBusyKey === row.key}
                          onAct={() => handlePlanned(row)}
                        />
                      ))}
                      {drafts.map((invoice) => renderInvoiceRow(invoice))}
                    </>
                  )
                ) : null}

                {/* ── Open ── */}
                <BandHeader
                  colSpan={columnCount}
                  title="Open"
                  count={openRows.length}
                  amountCents={openBalanceCents}
                  open={openOpen}
                  onToggle={() => setOpenOpen((value) => !value)}
                />
                {openOpen ? (
                  openRows.length === 0 ? (
                    <EmptyBand
                      colSpan={columnCount}
                      title={search.trim() ? "No open invoices match" : "Nothing outstanding"}
                      body={search.trim() ? "Try a different number or name." : "Every issued invoice has been paid."}
                    />
                  ) : (
                    openRows.map((invoice) => renderInvoiceRow(invoice))
                  )
                ) : null}

                {/* ── History ── */}
                <BandHeader
                  colSpan={columnCount}
                  title="History"
                  count={history.loaded ? history.total : summary.bands.paid + summary.bands.void}
                  open={historyOpen}
                  onToggle={() => setHistoryOpen((value) => !value)}
                />
                {historyOpen ? (
                  !history.loaded ? (
                    <SkeletonRows colSpan={columnCount} />
                  ) : history.rows.length === 0 ? (
                    <EmptyBand
                      colSpan={columnCount}
                      title={search.trim() ? "Nothing settled matches" : "Nothing settled yet"}
                      body={search.trim() ? "Try a different number or name." : "Paid and voided invoices collect here."}
                    />
                  ) : (
                    <>
                      {history.rows.map((invoice) => renderInvoiceRow(invoice))}
                      {history.rows.length < history.total ? (
                        <TableRow>
                          <TableCell colSpan={columnCount} className="px-4 py-2 text-center text-xs text-muted-foreground">
                            Showing {history.rows.length} of {history.total}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="ml-2 h-7"
                              onClick={() => void loadHistory({ more: true })}
                              disabled={history.loading}
                            >
                              {history.loading ? "Loading…" : "Load more"}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </>
                  )
                ) : null}
              </TableBody>
            </Table>
          )}
          {rows.length < activeTotal ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground sm:px-6 lg:px-8">
              Showing the {rows.length} most recent of {activeTotal} active invoices. Search to find the rest.
            </p>
          ) : null}
        </div>

        <aside
          aria-hidden={!selectedId}
          className={cn(
            "min-h-0 shrink-0 overflow-hidden bg-background transition-[width] duration-200 ease-out motion-reduce:transition-none lg:h-full",
            selectedId ? "block w-full border-t lg:w-[440px] lg:border-l lg:border-t-0 xl:w-[520px]" : "hidden w-0 lg:block",
          )}
        >
          <div className="w-full lg:h-full lg:w-[440px] xl:w-[520px]">
            {selectedId ? (
              <InvoiceInspector
                detail={detail}
                placeholder={selectedRow}
                loading={detailLoading}
                error={detailError}
                accounting={accountingForInvoice(detail?.invoice ?? selectedRow)}
                projectId={detail?.invoice.project_id ?? effectiveProjectId ?? null}
                projectName={
                  detail?.invoice.project_id
                    ? projectById.get(detail.invoice.project_id)?.name ?? null
                    : scopedProject?.name ?? null
                }
                builderInfo={builderInfo}
                autoOpenPayment={autoPaymentFor === selectedId}
                onAutoPaymentHandled={() => setAutoPaymentFor(null)}
                onBack={() => selectInvoice(null)}
                onChanged={() => refreshAll(selectedId)}
                onRetry={() => void refreshDetail()}
                onDuplicate={(invoice) => {
                  const target = invoice.project_id ?? effectiveProjectId
                  if (!target) return
                  if (projectId) openCompose({ duplicateOf: invoice.id })
                  else router.push(newInvoiceHref(target, { duplicateOf: invoice.id }))
                }}
                onEdit={projectId ? (invoice) => openCompose({ draftId: invoice.id }) : undefined}
                onRevise={(invoice) => setRevisingInvoice(invoice)}
                onVoid={(invoice) => setVoidingInvoice(invoice)}
                onMakeRecurring={(invoice) => setRecurringInvoice(invoice)}
                onMove={(invoice) => setMovingInvoice(invoice)}
                onResync={async (invoice) => {
                  if (!labels.canRequestExternalSync) return
                  try {
                    unwrapAction(await manualResyncInvoiceAction(invoice.id))
                    toast.success("Sync queued")
                    await refreshAll(invoice.id)
                  } catch (error) {
                    toast.error("Could not sync", {
                      description: error instanceof Error ? error.message : "Please try again.",
                    })
                  }
                }}
              />
            ) : null}
          </div>
        </aside>
      </div>

      {selectedIds.length > 0 ? (
        <InvoiceBottomBar
          selectedCount={selectedIds.length}
          totalCents={selectedInvoices.reduce((sum, invoice) => sum + balanceCentsOf(invoice), 0)}
          actions={bulk}
          busy={bulkBusy}
          onDeselectAll={() => setSelectedIds([])}
          onSend={() => void handleBulkSend()}
          onRemind={() => void handleBulkReminders()}
          onVoid={() => setBulkConfirm("void")}
          onDelete={() => setBulkConfirm("delete")}
          onExportCsv={handleExportCsv}
        />
      ) : null}

      <AlertDialog open={bulkConfirm !== null} onOpenChange={(open) => !open && setBulkConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{bulkConfirm === "void" ? `Void ${bulk.voidable} invoice${bulk.voidable === 1 ? "" : "s"}?` : `Delete ${bulk.deletable} draft${bulk.deletable === 1 ? "" : "s"}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {bulkConfirm === "void"
                ? `This cancels each one and releases ${releaseDescription} so they can be billed again. Records and history stay.`
                : "Drafts that were never issued are removed outright. Anything already billed is left alone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkBusy !== null}>Keep them</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkBusy !== null}
              className={bulkConfirm === "delete" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : undefined}
              onClick={(event) => {
                event.preventDefault()
                const action = bulkConfirm === "void" ? handleBulkVoid : handleBulkDelete
                setBulkConfirm(null)
                void action()
              }}
            >
              {bulkConfirm === "void" ? "Void" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {projectId && composeTarget ? (
        <InvoiceComposer
          project={projects[0]}
          profile={profile}
          target={composeTarget}
          onClose={(invoiceId) => {
            closeCompose()
            if (invoiceId) {
              selectInvoice(invoiceId)
              void refreshAll(invoiceId)
            }
          }}
          onIssued={(invoice) => {
            closeCompose()
            placeInvoice(invoice)
            void refreshAll(invoice.id)
          }}
        />
      ) : null}

      {/* One takeover at a time: the composer wins if both are addressed. */}
      {projectId && payAppParam && !composeTarget ? (
        <PayApplicationWorkspace
          key={payAppParam}
          projectId={projectId}
          target={payAppParam}
          onClose={() => setPayAppParam(null)}
          onChanged={() => void refreshAll()}
          onInvoiceCreated={(invoiceId) => {
            if (invoiceId) selectInvoice(invoiceId)
            void refreshAll(invoiceId ?? undefined)
          }}
          onOpenSov={() => {
            setPayAppParam(null)
            setManageParam("sov")
          }}
        />
      ) : null}

      {projectId ? (
        <BillingManageSheets
          projectId={projectId}
          contract={contract}
          costCodesEnabled={costCodesEnabled}
          surface={manageSurface}
          progressBilling={profile.progressBilling}
          onClose={() => setManageParam(null)}
          onInvoiceCreated={(invoice) => {
            if (invoice) placeInvoice(invoice)
            else if (selectedId) selectInvoice(selectedId)
            void refreshAll()
          }}
          onChanged={() => void refreshAll()}
        />
      ) : null}

      {projectId && billRow ? (
        <BillCostsWorkspace
          project={projects[0]}
          profile={profile}
          row={billRow}
          periods={upNext?.periods ?? []}
          builderInfo={builderInfo}
          onClose={() => setBillRow(null)}
          onCreated={async (invoiceId) => {
            setBillRow(null)
            selectInvoice(invoiceId)
            await refreshAll()
          }}
        />
      ) : null}
      <AccountingSyncSheet
        open={syncQueueOpen}
        onOpenChange={setSyncQueueOpen}
        projectId={effectiveProjectId}
        projectName={scopedProject?.name}
        onOpenInvoice={selectInvoice}
      />
      <MakeRecurringDialog
        invoice={recurringInvoice}
        open={Boolean(recurringInvoice)}
        onOpenChange={(open) => !open && setRecurringInvoice(null)}
      />
      <ChooseProjectDialog
        open={newInvoiceProjectOpen}
        onOpenChange={setNewInvoiceProjectOpen}
        projects={projects}
        onChoose={(id) => router.push(newInvoiceHref(id))}
      />
      <MoveInvoiceDialog
        invoice={movingInvoice}
        releaseDescription={releaseDescription}
        onClose={() => setMovingInvoice(null)}
        onMoved={async () => {
          const moved = movingInvoice
          setMovingInvoice(null)
          if (selectedId && moved?.id === selectedId) selectInvoice(null)
          await refreshAll(moved?.id)
        }}
      />

      <AlertDialog open={Boolean(voidingInvoice)} onOpenChange={(open) => !open && setVoidingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels {voidingInvoice?.invoice_number ?? "the invoice"} and releases {voidingInvoice ? invoiceReleaseDescription(profileForInvoice(voidingInvoice).costDriven) : releaseDescription} so they can
              be billed again. The record and its history stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveBusy}>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={destructiveBusy} onClick={() => void handleVoid()}>
              {destructiveBusy ? "Voiding…" : "Void invoice"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(revisingInvoice)} onOpenChange={(open) => !open && setRevisingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit {revisingInvoice?.invoice_number ?? "this invoice"}?</AlertDialogTitle>
            <AlertDialogDescription>
              An issued invoice never changes, so editing means revising it: this voids the one the customer has, keeps
              its history, and opens a replacement draft with a new number for you to change and send.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={destructiveBusy} onClick={() => void handleRevise()}>
              {destructiveBusy ? "Opening…" : "Void and edit a copy"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(deletingInvoice)} onOpenChange={(open) => !open && setDeletingInvoice(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingInvoice?.invoice_number ?? "This draft"} has never been issued, so it can be removed outright.
              Anything already billed has to be voided instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={destructiveBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={destructiveBusy}
              onClick={() => void handleDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {destructiveBusy ? "Deleting…" : "Delete draft"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )

  function renderInvoiceRow(invoice: Invoice) {
    const rowProfile = profileForInvoice(invoice)
    const rowAccounting = accountingForInvoice(invoice)
    const rowLabels = receivablesLabels(rowAccounting)
    const payApplication = applicationByInvoice.get(invoice.id)
    const payApplicationId = payApplication?.id ?? (typeof invoice.metadata?.source_pay_application_id === "string" ? invoice.metadata.source_pay_application_id : null)
    const openApplication = projectId && payApplicationId && (payApplication || displayStatusOf(invoice) !== "void") ? () => setPayAppParam(payApplicationId) : null
    const action = nextActionFor(invoice)
    const active = invoice.id === selectedId
    const balance = balanceCentsOf(invoice)
    const status = displayStatusOf(invoice)
    const backup = packageByInvoice.get(invoice.id)
    const primaryShortcut: MenuShortcut | null = (() => {
      if (scope.kind !== "org") return null
      if (action.key === "resume" && invoice.project_id) {
        return { label: "Resume", href: newInvoiceHref(invoice.project_id).replace("compose=new", `compose=${invoice.id}`) }
      }
      if (action.key === "issue") return { label: "Send", onSelect: () => void handleIssue(invoice) }
      if (action.key === "remind" || action.key === "resend") {
        return { label: action.key === "resend" ? "Resend" : "Remind", onSelect: () => void handleReminder(invoice) }
      }
      if (action.key === "collect") {
        return {
          label: rowLabels.recordPayment,
          onSelect: () => {
            setAutoPaymentFor(invoice.id)
            selectInvoice(invoice.id)
          },
        }
      }
      if (action.key === "approve" || action.key === "scheduled") {
        return { label: action.label, onSelect: () => selectInvoice(invoice.id) }
      }
      return null
    })()
    return (
      <TableRow
        key={invoice.id}
        data-state={active ? "selected" : undefined}
        onClick={(event) => {
          const target = event.target as HTMLElement
          if (target.closest("button, a, input, [role='checkbox'], [role='menu']")) return
          if (openApplication) openApplication()
          else selectInvoice(invoice.id)
        }}
        onMouseEnter={() => hover.arm(invoice)}
        onMouseLeave={hover.cancel}
        onFocus={() => hover.arm(invoice)}
        className={cn(
          // No content-visibility here: a contained <tr> lays out on its own and its
          // cells stop sharing the table's column widths, so the row ends early.
          "group cursor-pointer animate-in fade-in duration-200 motion-reduce:animate-none",
          active && "bg-muted/60",
          status === "void" && "text-muted-foreground",
        )}
      >
        {showSelection ? (
          <TableCell className="w-10 px-3">
            <Checkbox
              checked={selectedIds.includes(invoice.id)}
              onCheckedChange={(checked) =>
                setSelectedIds((prev) => (checked ? [...new Set([...prev, invoice.id])] : prev.filter((id) => id !== invoice.id)))
              }
              aria-label={`Select invoice ${invoice.invoice_number ?? ""}`}
            />
          </TableCell>
        ) : null}
        <TableCell className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="font-medium">{payApplication ? `${payApplication.is_retainage_release ? "Retainage release" : "Pay application"} #${payApplication.application_number}${payApplication.revision ? ` · r${payApplication.revision}` : ""}` : payApplicationId ? invoice.title || "Pay application" : invoice.invoice_number || invoice.title || "Untitled"}</span>
            {invoiceNeedsAttention(invoice) ? (
              <AccountingSyncBadge status={invoice.qbo_sync_status} externalId={invoice.qbo_id ?? undefined} compact />
            ) : null}
          </div>
          {payApplicationId ? <button type="button" className="mt-1 block text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => selectInvoice(invoice.id)}>{invoice.invoice_number || "Linked invoice"}{payApplication ? ` · through ${payApplication.period_end}` : ""}</button> : null}
          {!projectId && compact && invoice.project_id ? (
            <span className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
              {projectById.get(invoice.project_id)?.name ?? "Unknown project"}
            </span>
          ) : null}
        </TableCell>
        {showClient ? (
          <TableCell className="px-4 py-2.5 text-sm">
            <span className="line-clamp-1">{customerNameOf(invoice) || "—"}</span>
            {invoice.project_id ? (
              <span className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                {projectById.get(invoice.project_id)?.name ?? "Unknown project"}
              </span>
            ) : null}
          </TableCell>
        ) : null}
        {showMemo ? (
          <TableCell className="max-w-[16rem] px-4 py-2.5 text-sm text-muted-foreground">
            <span className="line-clamp-1">{invoiceMemo(invoice)}</span>
          </TableCell>
        ) : null}
        {compact ? null : (
          <TableCell className="px-4 py-2.5 text-right font-mono text-sm tabular-nums">
            {formatMoneyFromCents(totalCentsOf(invoice))}
          </TableCell>
        )}
        <TableCell
          className={cn(
            "px-4 py-2.5 text-right font-mono text-sm tabular-nums",
            balance > 0 && status !== "void" ? "font-semibold" : "text-muted-foreground",
          )}
        >
          {formatMoneyFromCents(status === "void" ? 0 : balance)}
        </TableCell>
        <TableCell className="px-4 py-2.5">
          <InvoiceStatusBadge invoice={invoice} />
        </TableCell>
        {projectId ? <TableCell className={cn("px-4 py-2.5 text-sm", NEXT_ACTION_TONES[action.tone])}>{action.label}</TableCell> : null}
        <TableCell className="px-4 py-2.5">
          <div className="flex items-center justify-end gap-1">
            {projectId && (openApplication ? <Button size="sm" variant="ghost" className="h-8" onClick={openApplication}>View application</Button> : <RowPrimaryAction
              invoice={invoice}
              busyKey={rowBusyId}
              projectId={invoice.project_id ?? effectiveProjectId ?? null}
              paymentLabel={rowLabels.recordPayment}
              onResume={projectId ? () => openCompose({ draftId: invoice.id }) : undefined}
              onIssue={() => void handleIssue(invoice)}
              onRemind={() => void handleReminder(invoice)}
              onRecordPayment={() => {
                setAutoPaymentFor(invoice.id)
                selectInvoice(invoice.id)
              }}
            />)}
            {openApplication ? <Button size="sm" variant="ghost" className="h-8" onClick={() => selectInvoice(invoice.id)}>Invoice</Button> : <RowOverflowMenu
              invoice={invoice}
              projectId={invoice.project_id ?? effectiveProjectId ?? null}
              customerLabel={scope.kind === "org" ? "Customer" : rowProfile.customerLabel}
              costDriven={rowProfile.costDriven}
              backup={backup}
              primaryShortcut={primaryShortcut}
              onDuplicate={projectId ? () => openCompose({ duplicateOf: invoice.id }) : undefined}
              onCopyLink={() => void handleCopyLink(invoice)}
              onMakeRecurring={() => setRecurringInvoice(invoice)}
              onRevise={() => setRevisingInvoice(invoice)}
              onVoid={() => setVoidingInvoice(invoice)}
              onDelete={() => setDeletingInvoice(invoice)}
              onMove={() => setMovingInvoice(invoice)}
              onGenerateBackup={async () => {
                if (!invoice.project_id) return
                try {
                  const result = unwrapAction(
                    await generateOwnerBillingPackageAction({ projectId: invoice.project_id, invoiceId: invoice.id }),
                  )
                  setPackages((prev) => [result, ...prev.filter((item) => item.invoice_id !== invoice.id)])
                  toast.success("Backup package generated", {
                    description: `${result.cost_count} costs and ${result.proof_count} proofs captured.`,
                  })
                } catch (error) {
                  toast.error("Could not generate the backup package", {
                    description: error instanceof Error ? error.message : "Please try again.",
                  })
                }
              }}
              onShareBackup={async () => {
                const summaryRow = packageByInvoice.get(invoice.id)
                if (!invoice.project_id || !summaryRow) return
                try {
                  const shared = unwrapAction(
                    await shareOwnerBillingPackageAction({ projectId: invoice.project_id, packageId: summaryRow.package_id }),
                  )
                  setPackages((prev) => [shared, ...prev.filter((item) => item.invoice_id !== invoice.id)])
                  toast.success("Backup shared to the portal")
                } catch (error) {
                  toast.error("Could not share the backup package", {
                    description: error instanceof Error ? error.message : "Please try again.",
                  })
                }
              }}
            />}
          </div>
        </TableCell>
      </TableRow>
    )
  }
}

/** The invoice's own words for what it is: its title, else the first line of its notes. */
function invoiceMemo(invoice: Invoice): string {
  const memo = typeof invoice.metadata?.memo === "string" ? invoice.metadata.memo.trim() : ""
  if (memo) return memo
  const title = (invoice.title ?? "").trim()
  if (title && title !== invoice.invoice_number) return title
  const note = (invoice.notes ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  return note ?? "—"
}

function isManageSurface(value: string | null): value is BillingManageSurface {
  return value === "draws" || value === "sov" || value === "retainage" || value === "recurring"
}

/** The three numbers a billing page opens with. No tiles: one line, read left to right. */
function SummaryLine({ summary }: { summary: ProjectBillingSummary }) {
  const overdueCount = summary.bands.overdue
  return (
    <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
      <div className="flex items-baseline gap-1.5">
        <dt className="microlabel">Outstanding</dt>
        <dd className="font-mono font-semibold tabular-nums">{formatMoneyCompact(summary.outstandingCents)}</dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="microlabel">Overdue</dt>
        <dd className={cn("font-mono font-semibold tabular-nums", summary.overdueCents > 0 ? "text-destructive" : "text-muted-foreground")}>
          {formatMoneyCompact(summary.overdueCents)}
          {overdueCount > 0 ? <span className="ml-1 text-xs font-normal text-muted-foreground">({overdueCount})</span> : null}
        </dd>
      </div>
      {summary.retainageHeldCents > 0 ? (
        <div className="flex items-baseline gap-1.5">
          <dt className="microlabel">Retainage held</dt>
          <dd className="font-mono tabular-nums text-muted-foreground">{formatMoneyCompact(summary.retainageHeldCents)}</dd>
        </div>
      ) : null}
    </dl>
  )
}

function BandHeader({
  colSpan,
  title,
  count,
  amountCents,
  open,
  onToggle,
  trailing,
}: {
  colSpan: number
  title: string
  count: number
  amountCents?: number
  open: boolean
  onToggle: () => void
  trailing?: React.ReactNode
}) {
  return (
    <TableRow
      className="sticky top-[2.375rem] z-10 cursor-pointer select-none hover:bg-transparent"
      onClick={onToggle}
      aria-expanded={open}
      role="button"
    >
      <TableCell colSpan={colSpan} className="border-y bg-muted px-3 py-0 transition-colors hover:bg-muted/80 sm:px-5 lg:px-7">
        <div className="flex h-9 items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground">
            <span className="flex h-5 w-5 items-center justify-center border bg-background text-muted-foreground">
              {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </span>
            {title}
            <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">{count}</span>
            {typeof amountCents === "number" && amountCents > 0 ? (
              <span className="font-mono text-[11px] font-normal tabular-nums text-muted-foreground">· {formatMoneyCompact(amountCents)}</span>
            ) : null}
          </span>
          {trailing ? <span onClick={(event) => event.stopPropagation()}>{trailing}</span> : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

function EmptyBand({ colSpan, title, body }: { colSpan: number; title: string; body: string }) {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={colSpan} className="px-4 py-6 text-center sm:px-6 lg:px-8">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{body}</p>
      </TableCell>
    </TableRow>
  )
}

function SkeletonRows({ colSpan }: { colSpan: number }) {
  return (
    <>
      {Array.from({ length: 4 }).map((_, index) => (
        <TableRow key={index} className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="px-4 py-3">
            <div className="flex items-center gap-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-20" />
              <Skeleton className="h-4 w-24" />
            </div>
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}

const PLANNED_STATE_LABEL: Record<UpNextRow["state"], { label: string; className: string }> = {
  due: { label: "Ready to bill", className: "text-primary" },
  upcoming: { label: "Upcoming", className: "text-muted-foreground" },
  blocked: { label: "Blocked", className: "text-warning" },
}

const PLANNED_STATUS_TONE: Record<UpNextRow["state"], string> = {
  due: "border-primary/20 bg-primary/10 text-primary",
  upcoming: "border-border bg-muted text-muted-foreground",
  blocked: "border-warning/20 bg-warning/10 text-warning",
}

function PlannedStatusBadge({ row }: { row: UpNextRow }) {
  const label = row.statusLabel ?? PLANNED_STATE_LABEL[row.state].label
  const tone = applicationStatusTone(label) ?? PLANNED_STATUS_TONE[row.state]
  return <Badge variant="outline" className={cn("whitespace-nowrap text-[10px] font-semibold uppercase tracking-tight", tone)}>{label}</Badge>
}

function applicationStatusTone(label: string) {
  if (label === "Draft" || label === "Planned" || label === "Void") return "border-border bg-muted text-muted-foreground"
  if (label === "Returned" || label === "Awaiting certification") return "border-warning/20 bg-warning/10 text-warning"
  if (label === "Certified" || label === "Paid") return "border-success/20 bg-success/10 text-success"
  if (label === "Submitted" || label === "Billed") return "border-primary/20 bg-primary/10 text-primary"
  return null
}

/** A billing event the contract implies but nobody has turned into an invoice yet. */
function PlannedRow({
  row,
  showSelection,
  showClient,
  showMemo,
  compact,
  showNextAction,
  busy,
  onAct,
}: {
  row: UpNextRow
  showSelection: boolean
  showClient: boolean
  showMemo: boolean
  compact: boolean
  showNextAction: boolean
  busy: boolean
  onAct: () => void
}) {
  const state = PLANNED_STATE_LABEL[row.state]
  const primary = row.state === "due"
  return (
    <TableRow
      className="cursor-pointer animate-in fade-in duration-200 motion-reduce:animate-none"
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest("button, a, input, [role='checkbox'], [role='menu']")) return
        onAct()
      }}
    >
      {showSelection ? <TableCell className="w-10 px-3" /> : null}
      <TableCell className="px-4 py-2.5">
        <span className="font-medium">{row.title}</span>
        {row.period && row.period.autopilotNotes.length > 0 ? (
          <span className="ml-2 text-[11px] text-muted-foreground" title={row.period.autopilotNotes.map((note) => note.title).join("\n")}>
            {row.period.autopilotNotes.length} Autopilot note{row.period.autopilotNotes.length === 1 ? "" : "s"}
          </span>
        ) : null}
        {showMemo ? null : <span className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{row.detail}</span>}
      </TableCell>
      {showClient ? <TableCell className="px-4 py-2.5 text-sm text-muted-foreground">{row.projectName ?? "—"}</TableCell> : null}
      {showMemo ? (
        <TableCell className="max-w-[16rem] px-4 py-2.5 text-sm text-muted-foreground">
          <span className="line-clamp-1">{row.detail}</span>
        </TableCell>
      ) : null}
      {compact ? null : (
        <TableCell className="px-4 py-2.5 text-right font-mono text-sm tabular-nums">
          {row.amountCents != null ? formatMoneyFromCents(row.amountCents) : <span className="text-muted-foreground">—</span>}
        </TableCell>
      )}
      <TableCell className="px-4 py-2.5 text-right font-mono text-sm tabular-nums text-muted-foreground">
        {compact && row.amountCents != null ? formatMoneyFromCents(row.amountCents) : "—"}
      </TableCell>
      <TableCell className="px-4 py-2.5"><PlannedStatusBadge row={row} /></TableCell>
      {showNextAction ? <TableCell className={cn("px-4 py-2.5 text-sm", state.className)}>{row.actionLabel}</TableCell> : null}
      <TableCell className="px-4 py-2.5">
        <div className="flex items-center justify-end">
          {showNextAction ? (
            <Button size="sm" variant={primary ? "default" : "ghost"} className="h-8 text-xs" disabled={busy} onClick={onAct}>
              {busy ? "Working…" : row.actionLabel}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
                  <MoreHorizontal className="h-4 w-4" />
                  <span className="sr-only">More actions for {row.projectName ?? row.title}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onAct}>{row.actionLabel}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function PeriodPicker({
  periods,
  selectedId,
  onChange,
}: {
  periods: ProjectBillingUpNext["periods"]
  selectedId: string | null
  onChange: (periodId: string | null) => void
}) {
  const selected = periods.find((period) => period.id === selectedId) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
          Period: <span className="font-medium text-foreground">{selected?.name ?? "All open costs"}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={() => onChange(null)}>All open costs</DropdownMenuItem>
        <DropdownMenuSeparator />
        {periods.map((period) => (
          <DropdownMenuItem key={period.id} onSelect={() => onChange(period.id)}>
            <span className="flex-1">{period.name}</span>
            <span className="ml-2 text-[11px] capitalize text-muted-foreground">{period.status}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One button per row, and it says what to do with THIS invoice. Never an
 * icon-only control and never revealed on hover: the person most likely to be
 * working this page all day is the one least likely to discover a hidden button.
 */
function RowPrimaryAction({
  invoice,
  busyKey,
  projectId,
  paymentLabel,
  onResume,
  onIssue,
  onRemind,
  onRecordPayment,
}: {
  invoice: Invoice
  busyKey: string | null
  projectId: string | null
  paymentLabel: string
  onResume?: () => void
  onIssue: () => void
  onRemind: () => void
  onRecordPayment: () => void
}) {
  const action = nextActionFor(invoice)
  const busy = (key: string) => busyKey === `${invoice.id}:${key}`

  if (action.key === "resume" && isEditableInvoice(invoice) && projectId) {
    return onResume ? (
      <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onResume}>
        Resume
      </Button>
    ) : (
      <Button variant="outline" size="sm" className="h-8 text-xs" asChild>
        <Link href={newInvoiceHref(projectId).replace("compose=new", `compose=${invoice.id}`)}>Resume</Link>
      </Button>
    )
  }
  if (action.key === "issue") {
    return (
      <Button size="sm" className="h-8 text-xs" onClick={onIssue} disabled={busy("issue")}>
        {busy("issue") ? "Sending…" : "Send"}
      </Button>
    )
  }
  if (action.key === "remind" || action.key === "resend") {
    return (
      <Button size="sm" variant="outline" className="h-8 border-destructive/35 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onRemind} disabled={busy("reminder")}>
        {busy("reminder") ? "Sending…" : action.key === "resend" ? "Resend" : "Remind"}
      </Button>
    )
  }
  if (action.key === "collect") {
    return (
      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onRecordPayment}>
        {paymentLabel}
      </Button>
    )
  }
  return null
}

type MenuShortcut = { label: string; href?: string; onSelect?: () => void }

function RowOverflowMenu({
  invoice,
  projectId,
  customerLabel,
  costDriven,
  backup,
  primaryShortcut,
  onDuplicate,
  onCopyLink,
  onMakeRecurring,
  onRevise,
  onVoid,
  onDelete,
  onMove,
  onGenerateBackup,
  onShareBackup,
}: {
  invoice: Invoice
  projectId: string | null
  customerLabel: string
  costDriven: boolean
  backup?: OwnerBillingPackageSummary
  primaryShortcut?: MenuShortcut | null
  onDuplicate?: () => void
  onCopyLink: () => void
  onMakeRecurring: () => void
  onRevise: () => void
  onVoid: () => void
  onDelete: () => void
  onMove: () => void
  onGenerateBackup: () => Promise<void>
  onShareBackup: () => Promise<void>
}) {
  const status = displayStatusOf(invoice)
  const editable = isEditableInvoice(invoice)
  const published = Boolean(invoice.client_visible && invoice.sent_at)
  const issued = Boolean(invoice.sent_at) || ["sent", "partial", "overdue", "paid"].includes(status)
  const canRevise = ["sent", "overdue"].includes(status)
  const canVoid = issued && !["paid", "partial", "void"].includes(status)
  const canShareBackup = Boolean(backup && !["shared", "downloaded", "accepted"].includes(backup.status))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">More actions for invoice {invoice.invoice_number}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {primaryShortcut ? (
          <>
            {primaryShortcut.href ? (
              <DropdownMenuItem asChild><Link href={primaryShortcut.href}>{primaryShortcut.label}</Link></DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={primaryShortcut.onSelect}>{primaryShortcut.label}</DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
          </>
        ) : null}
        {published ? (
          <DropdownMenuItem onSelect={onCopyLink}>Copy {customerLabel.toLowerCase()} link</DropdownMenuItem>
        ) : (
          // Naming the consequence: for an unissued invoice this MINTS public access.
          <DropdownMenuItem onSelect={onCopyLink}>Publish a {customerLabel.toLowerCase()} link…</DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {onDuplicate ? (
          <DropdownMenuItem onSelect={onDuplicate}>Duplicate</DropdownMenuItem>
        ) : projectId ? (
          <DropdownMenuItem asChild>
            <Link href={newInvoiceHref(projectId, { duplicateOf: invoice.id })}>Duplicate</Link>
          </DropdownMenuItem>
        ) : null}
        {status !== "void" ? <DropdownMenuItem onSelect={onMakeRecurring}>Make recurring…</DropdownMenuItem> : null}
        {canRevise ? <DropdownMenuItem onSelect={onRevise}>Revise and reissue</DropdownMenuItem> : null}
        {editable ? <DropdownMenuItem onSelect={onMove}>Move to project…</DropdownMenuItem> : null}
        {costDriven && issued && invoice.project_id ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void onGenerateBackup()}>
              {backup ? "Regenerate backup package" : "Generate backup package"}
            </DropdownMenuItem>
            {canShareBackup ? (
              <DropdownMenuItem onSelect={() => void onShareBackup()}>Share backup to portal</DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {canVoid || editable ? (
          <>
            <DropdownMenuSeparator />
            {canVoid ? (
              <DropdownMenuItem onSelect={onVoid} className="text-destructive focus:text-destructive">
                Void invoice
              </DropdownMenuItem>
            ) : null}
            {editable ? (
              <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
                Delete draft
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChooseProjectDialog({
  open,
  onOpenChange,
  projects,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  onChoose: (projectId: string) => void
}) {
  const [search, setSearch] = useState("")
  const visible = projects.filter(
    (project) => search.trim().length === 0 || project.name.toLowerCase().includes(search.trim().toLowerCase()),
  )
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Which job are you billing?</DialogTitle>
          <DialogDescription>
            The project decides the billing workflow — a draw schedule, a pay application, or a closing statement.
          </DialogDescription>
        </DialogHeader>
        <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" className="h-9" />
        <div className="max-h-64 space-y-1 overflow-y-auto border p-1">
          {visible.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => {
                onOpenChange(false)
                onChoose(project.id)
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
            >
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{project.name}</span>
            </button>
          ))}
          {visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No projects match.</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function MoveInvoiceDialog({
  invoice,
  releaseDescription,
  onClose,
  onMoved,
}: {
  invoice: Invoice | null
  releaseDescription: string
  onClose: () => void
  onMoved: () => void | Promise<void>
}) {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [moving, setMoving] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [search, setSearch] = useState("")

  useEffect(() => {
    if (!invoice) return
    setTargetId(null)
    setSearch("")
    setLoading(true)
    listMovableProjectsAction()
      .then((result) => setProjects(unwrapAction(result).filter((project) => project.id !== invoice.project_id)))
      .catch((error) =>
        toast.error("Could not load projects", {
          description: error instanceof Error ? error.message : "Please try again.",
        }),
      )
      .finally(() => setLoading(false))
  }, [invoice])

  async function submit() {
    if (!invoice || !targetId) return
    setMoving(true)
    try {
      unwrapAction(await moveInvoiceToProjectAction(invoice.id, targetId))
      toast.success("Invoice moved", { description: projects.find((p) => p.id === targetId)?.name })
      await onMoved()
    } catch (error) {
      toast.error("Could not move the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setMoving(false)
    }
  }

  const visible = projects.filter(
    (project) => search.trim().length === 0 || project.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <Dialog open={Boolean(invoice)} onOpenChange={(open) => !open && !moving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to another project</DialogTitle>
          <DialogDescription>
            {invoice?.invoice_number ?? "This invoice"} moves with its lines. Any {releaseDescription} linked to the
            current project are released so they can be billed there again.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search projects"
          className="h-9"
          disabled={loading || moving}
        />
        <div className="max-h-64 space-y-1 overflow-y-auto border p-1">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Loading projects…</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {projects.length === 0 ? "No other projects available." : "No projects match."}
            </p>
          ) : (
            visible.map((project) => (
              <button
                key={project.id}
                type="button"
                disabled={moving}
                onClick={() => setTargetId(project.id)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                  targetId === project.id && "bg-muted font-medium",
                )}
              >
                <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{project.name}</span>
              </button>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={moving}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!targetId || moving}>
            {moving ? "Moving…" : "Move invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
