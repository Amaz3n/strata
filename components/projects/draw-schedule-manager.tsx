"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Calendar as CalendarIcon,
  FileText,
  Link2,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  ReceiptText,
  Search,
  Trash2,
  Unlink,
  X,
} from "lucide-react"
import { toast } from "sonner"

import type { Contract, DrawSchedule, ScheduleItem, CostCode, Invoice, InvoiceView } from "@/lib/types"
import { cn, parseLocalDate, formatLocalDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetDescription } from "@/components/ui/sheet"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import { InvoiceDetailSheet } from "@/components/invoices/invoice-detail-sheet"

import {
  createProjectDrawAction,
  deleteProjectDrawAction,
  generateDrawPayApplicationAction,
  generateInvoiceFromDrawAction,
  linkInvoiceToDrawAction,
  listLinkableInvoicesForDrawAction,
  listProjectDrawsAction,
  reorderProjectDrawsAction,
  unlinkInvoiceFromDrawAction,
  updateProjectDrawAction,
} from "@/app/(app)/projects/[id]/actions"
import { getInvoiceDetailAction, manualResyncInvoiceAction } from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"

const statusMap: Record<string, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "bg-amber-100 text-amber-700" },
  invoiced: { label: "Invoiced", tone: "bg-blue-100 text-blue-700" },
  partial: { label: "Partial", tone: "bg-purple-100 text-purple-700" },
  paid: { label: "Paid", tone: "bg-emerald-100 text-emerald-700" },
}

type AmountMode = "fixed" | "percent"
type DueMode = "date" | "milestone" | "approval"

type LinkableInvoice = {
  id: string
  invoice_number: string
  title: string | null
  status: string
  total_cents: number
  linked_draw_cents: number
  remaining_draw_cents: number
  issue_date: string | null
  from_qbo: boolean
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function toDollars(cents?: number | null) {
  return typeof cents === "number" ? String(Math.round(cents / 100)) : ""
}

function parseDollarsToCents(value: string) {
  const normalized = value.replace(/[^\d.]/g, "")
  const parsed = Number.parseFloat(normalized)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.round(parsed * 100)
}

function isDepositDraw(draw: Pick<DrawSchedule, "draw_number" | "metadata">) {
  return Boolean((draw.metadata as any)?.is_deposit) || draw.draw_number === 0
}

export function DrawScheduleManager({
  projectId,
  initialDraws,
  contract,
  scheduleItems,
  costCodes,
  compact = false,
  onInvoiceGenerationStart,
  onInvoiceGenerated,
  onInvoiceGenerationFailed,
}: {
  projectId: string
  initialDraws: DrawSchedule[]
  contract: Contract | null
  scheduleItems?: ScheduleItem[]
  costCodes?: CostCode[]
  compact?: boolean
  onInvoiceGenerationStart?: (draw: DrawSchedule) => void
  onInvoiceGenerated?: (result: { invoice: Invoice; invoice_id: string; invoice_number: string; draw: DrawSchedule }) => void
  onInvoiceGenerationFailed?: () => void
}) {
  const [draws, setDraws] = useState<DrawSchedule[]>(initialDraws)
  const [saving, startSaving] = useTransition()
  const [generatingInvoiceDrawId, setGeneratingInvoiceDrawId] = useState<string | null>(null)
  const [generatingPayAppDrawId, setGeneratingPayAppDrawId] = useState<string | null>(null)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DrawSchedule | null>(null)
  const [selectedDraw, setSelectedDraw] = useState<DrawSchedule | null>(null)
  const [invoiceDetailOpen, setInvoiceDetailOpen] = useState(false)
  const [linkedInvoiceLoading, setLinkedInvoiceLoading] = useState(false)
  const [linkedInvoice, setLinkedInvoice] = useState<Invoice | null>(null)
  const [linkedInvoiceLink, setLinkedInvoiceLink] = useState<string | undefined>()
  const [linkedInvoiceViews, setLinkedInvoiceViews] = useState<InvoiceView[] | undefined>()
  const [linkedInvoiceSyncHistory, setLinkedInvoiceSyncHistory] = useState<
    Array<{ id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }>
  >()
  const [invoiceResyncing, setInvoiceResyncing] = useState(false)
  const [search, setSearch] = useState("")
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const [linkableInvoices, setLinkableInvoices] = useState<LinkableInvoice[]>([])
  const [linkableLoading, setLinkableLoading] = useState(false)
  const [linkingInvoiceId, setLinkingInvoiceId] = useState<string | null>(null)
  const [unlinking, setUnlinking] = useState(false)

  const milestonesById = useMemo(() => {
    const map = new Map<string, ScheduleItem>()
    for (const item of scheduleItems ?? []) {
      map.set(item.id, item)
    }
    return map
  }, [scheduleItems])

  const normalizedScheduleItems = useMemo(() => {
    return (scheduleItems ?? []).filter((item) => item.item_type === "milestone" || item.item_type === "task")
  }, [scheduleItems])

  const revisedContractCents = useMemo(() => {
    return contract?.total_cents ?? 0
  }, [contract?.total_cents])

  const effectiveAmountCents = useCallback((draw: DrawSchedule) => {
    if (typeof draw.percent_of_contract === "number" && revisedContractCents > 0) {
      return Math.round((revisedContractCents * draw.percent_of_contract) / 100)
    }
    return draw.amount_cents ?? 0
  }, [revisedContractCents])

  const nextActionDraw = draws.find((draw) => {
    if (draw.status !== "pending" || draw.invoice_id) return false
    if (draw.due_trigger === "date") {
      return Boolean(draw.due_date && draw.due_date <= new Date().toISOString().slice(0, 10))
    }
    if (draw.due_trigger === "milestone" && draw.milestone_id) {
      const milestone = milestonesById.get(draw.milestone_id)
      return Boolean(
        milestone &&
          (milestone.status === "completed" ||
            (milestone.status as string) === "done" ||
            Number(milestone.progress ?? 0) >= 100),
      )
    }
    return false
  })

  const hasDeposit = useMemo(() => draws.some((draw) => isDepositDraw(draw)), [draws])

  function openCreate() {
    setEditing(null)
    setIsDialogOpen(true)
  }

  function openEdit(draw: DrawSchedule) {
    setSelectedDraw(null)
    setEditing(draw)
    setIsDialogOpen(true)
  }

  const loadLinkedInvoice = useCallback(async (invoiceId: string) => {
    setLinkedInvoiceLoading(true)
    try {
      const result = unwrapAction(await getInvoiceDetailAction(invoiceId))
      setLinkedInvoice(result.invoice)
      setLinkedInvoiceLink(result.link)
      setLinkedInvoiceViews(result.views)
      setLinkedInvoiceSyncHistory(result.syncHistory)
      return result.invoice
    } catch (err: any) {
      toast.error("Could not load linked invoice", { description: err?.message ?? "Please try again." })
      setLinkedInvoice(null)
      setLinkedInvoiceLink(undefined)
      setLinkedInvoiceViews(undefined)
      setLinkedInvoiceSyncHistory(undefined)
      return null
    } finally {
      setLinkedInvoiceLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!selectedDraw?.invoice_id) {
      setLinkedInvoice(null)
      setLinkedInvoiceLink(undefined)
      setLinkedInvoiceViews(undefined)
      setLinkedInvoiceSyncHistory(undefined)
      return
    }

    void loadLinkedInvoice(selectedDraw.invoice_id)
  }, [loadLinkedInvoice, selectedDraw?.invoice_id])

  async function refreshDrawsAndLinkedInvoice(invoiceId?: string | null) {
    const freshDraws = await listProjectDrawsAction(projectId)
    setDraws(freshDraws)
    setSelectedDraw((current) => {
      if (!current) return current
      return freshDraws.find((draw) => draw.id === current.id) ?? current
    })
    if (invoiceId) {
      await loadLinkedInvoice(invoiceId)
    }
  }

  async function openLinkedInvoiceDetail() {
    if (!selectedDraw?.invoice_id) return
    setInvoiceDetailOpen(true)
    if (!linkedInvoice || linkedInvoice.id !== selectedDraw.invoice_id) {
      await loadLinkedInvoice(selectedDraw.invoice_id)
    }
  }

  async function handleSave(input: {
    draw_number?: number
    is_deposit?: boolean
    title: string
    description?: string
    amount_mode: AmountMode
    amount_dollars?: string
    percent_of_contract?: number | null
    due_mode: DueMode
    due_date?: string | null
    milestone_id?: string | null
    due_trigger_label?: string | null
    allocations?: { cost_code_id: string; amount_cents: number; description?: string }[]
  }) {
    startSaving(async () => {
      try {
        const amount_cents =
          input.amount_mode === "percent"
            ? Math.round((revisedContractCents * (input.percent_of_contract ?? 0)) / 100)
            : parseDollarsToCents(input.amount_dollars ?? "")

        const payload = {
          draw_number: input.draw_number,
          is_deposit: input.is_deposit,
          title: input.title,
          description: input.description,
          amount_cents,
          percent_of_contract: input.amount_mode === "percent" ? input.percent_of_contract ?? 0 : null,
          due_trigger: input.due_mode,
          due_date: input.due_mode === "date" ? (input.due_date ?? null) : null,
          milestone_id: input.due_mode === "milestone" ? (input.milestone_id ?? null) : null,
          due_trigger_label: input.due_mode === "approval" ? (input.due_trigger_label ?? null) : null,
          allocations: input.allocations && input.allocations.length > 0 ? input.allocations : undefined,
        }

        if (editing) {
          const updated = unwrapAction(await updateProjectDrawAction(projectId, editing.id, payload))
          setDraws((prev) => prev.map((d) => (d.id === updated.id ? updated : d)).sort((a, b) => a.draw_number - b.draw_number))
          setSelectedDraw((current) => (current?.id === updated.id ? updated : current))
          toast.success("Draw updated")
        } else {
          const created = unwrapAction(await createProjectDrawAction(projectId, payload))
          setDraws((prev) => [...prev, created].sort((a, b) => a.draw_number - b.draw_number))
          toast.success("Draw created")
        }

        setIsDialogOpen(false)
        setEditing(null)
      } catch (err: any) {
        toast.error("Could not save draw", { description: err?.message ?? "Please try again." })
      }
    })
  }

  async function handleDelete(draw: DrawSchedule) {
    startSaving(async () => {
      try {
        unwrapAction(await deleteProjectDrawAction(projectId, draw.id))
        setDraws((prev) => prev.filter((d) => d.id !== draw.id))
        setSelectedDraw((current) => (current?.id === draw.id ? null : current))
        toast.success("Draw deleted")
      } catch (err: any) {
        toast.error("Could not delete draw", { description: err?.message ?? "Please try again." })
      }
    })
  }

  async function handleMove(draw: DrawSchedule, direction: "up" | "down") {
    // The deposit ("Draw 0") is pinned first and excluded from reordering so the
    // renumber-to-1..n in the action never clobbers its number.
    if (isDepositDraw(draw)) return
    const movable = draws.filter((d) => !isDepositDraw(d))
    const idx = movable.findIndex((d) => d.id === draw.id)
    const nextIdx = direction === "up" ? idx - 1 : idx + 1
    if (idx < 0 || nextIdx < 0 || nextIdx >= movable.length) return

    const ordered = [...movable]
    const [moved] = ordered.splice(idx, 1)
    ordered.splice(nextIdx, 0, moved)

    startSaving(async () => {
      try {
        const orderedIds = ordered.map((d) => d.id)
        const updated = unwrapAction(await reorderProjectDrawsAction(projectId, orderedIds))
        setDraws(updated)
      } catch (err: any) {
        toast.error("Could not reorder draws", { description: err?.message ?? "Please try again." })
      }
    })
  }

  async function handleGenerateInvoice(draw: DrawSchedule) {
    setGeneratingInvoiceDrawId(draw.id)
    onInvoiceGenerationStart?.(draw)
    try {
      const result = unwrapAction(await generateInvoiceFromDrawAction(projectId, draw.id))
      setDraws((prev) => prev.map((d) => (d.id === result.draw.id ? result.draw : d)))
      setSelectedDraw(result.draw)
      onInvoiceGenerated?.({
        invoice: result.invoice as Invoice,
        invoice_id: result.invoice_id,
        invoice_number: result.invoice_number,
        draw: result.draw,
      })
      toast.success("Invoice draft created", {
        description: `Review invoice #${result.invoice_number} before sending it to the client.`,
      })
    } catch (err: any) {
      onInvoiceGenerationFailed?.()
      toast.error("Could not generate invoice", { description: err?.message ?? "Please try again." })
    } finally {
      setGeneratingInvoiceDrawId(null)
    }
  }

  async function handleGeneratePayApplication(draw: DrawSchedule) {
    setGeneratingPayAppDrawId(draw.id)
    try {
      const result = unwrapAction(await generateDrawPayApplicationAction(projectId, draw.id))
      const bytes = Uint8Array.from(atob(result.pdfBase64), (char) => char.charCodeAt(0))
      const blob = new Blob([bytes], { type: "application/pdf" })
      const url = URL.createObjectURL(blob)
      const popup = window.open(url, "_blank", "noopener,noreferrer")
      if (!popup) {
        const link = document.createElement("a")
        link.href = url
        link.download = result.fileName
        document.body.appendChild(link)
        link.click()
        link.remove()
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err: any) {
      toast.error("Could not generate pay application", { description: err?.message ?? "Please try again." })
    } finally {
      setGeneratingPayAppDrawId(null)
    }
  }

  async function openLinkPicker() {
    if (!selectedDraw) return
    setLinkPickerOpen(true)
    setLinkableLoading(true)
    try {
      const invoices = await listLinkableInvoicesForDrawAction(projectId, selectedDraw.id)
      setLinkableInvoices(invoices)
    } catch (err: any) {
      toast.error("Could not load invoices", { description: err?.message ?? "Please try again." })
      setLinkableInvoices([])
    } finally {
      setLinkableLoading(false)
    }
  }

  async function handleLinkInvoice(invoiceId: string) {
    if (!selectedDraw) return
    setLinkingInvoiceId(invoiceId)
    try {
      const result = unwrapAction(await linkInvoiceToDrawAction(projectId, selectedDraw.id, invoiceId))
      setDraws((prev) => prev.map((d) => (d.id === result.draw.id ? (result.draw as DrawSchedule) : d)))
      setSelectedDraw(result.draw as DrawSchedule)
      setLinkPickerOpen(false)
      toast.success("Invoice linked to draw")
      await loadLinkedInvoice(invoiceId)
    } catch (err: any) {
      toast.error("Could not link invoice", { description: err?.message ?? "Please try again." })
    } finally {
      setLinkingInvoiceId(null)
    }
  }

  async function handleUnlinkInvoice() {
    if (!selectedDraw) return
    setUnlinking(true)
    try {
      const result = unwrapAction(await unlinkInvoiceFromDrawAction(projectId, selectedDraw.id))
      setDraws((prev) => prev.map((d) => (d.id === result.draw.id ? (result.draw as DrawSchedule) : d)))
      setSelectedDraw(result.draw as DrawSchedule)
      setLinkedInvoice(null)
      setLinkedInvoiceLink(undefined)
      setLinkedInvoiceViews(undefined)
      setLinkedInvoiceSyncHistory(undefined)
      toast.success("Invoice unlinked")
    } catch (err: any) {
      toast.error("Could not unlink invoice", { description: err?.message ?? "Please try again." })
    } finally {
      setUnlinking(false)
    }
  }

  const filteredDraws = useMemo(() => {
    if (!search.trim()) return draws
    const s = search.toLowerCase()
    return draws.filter((d) => d.title?.toLowerCase().includes(s) || d.description?.toLowerCase().includes(s))
  }, [draws, search])

  const movableDraws = useMemo(() => draws.filter((d) => !isDepositDraw(d)), [draws])
  const firstMovableId = movableDraws[0]?.id
  const lastMovableId = movableDraws[movableDraws.length - 1]?.id

  function drawDueLabel(draw: DrawSchedule) {
    const milestone = draw.milestone_id ? milestonesById.get(draw.milestone_id) : undefined
    if (draw.due_trigger === "milestone") {
      if (!milestone) return "Milestone"
      const projectedDate = milestone.end_date ? formatLocalDate(milestone.end_date, "MMM d, yyyy") : ""
      return `${milestone.name}${projectedDate ? ` · ${projectedDate}` : ""}`
    }
    if (draw.due_date) return formatLocalDate(draw.due_date, "MMM d, yyyy")
    if ((draw.metadata as any)?.due_trigger_label) return (draw.metadata as any).due_trigger_label
    return "No trigger"
  }

  function drawBasisLabel(draw: DrawSchedule) {
    if (typeof draw.percent_of_contract === "number") {
      return `${draw.percent_of_contract}%`
    }
    if (revisedContractCents > 0) {
      const amount = effectiveAmountCents(draw)
      return `${Math.round((amount / revisedContractCents) * 1000) / 10}%`
    }
    return "Fixed"
  }

  return (
    <div className="w-full bg-background">
      <div className="flex flex-col gap-3 border-b bg-background px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="relative w-full lg:max-w-lg">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search draws"
            className="h-9 rounded-md border-muted-foreground/20 bg-muted/20 pl-9 pr-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search ? (
            <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" onClick={() => setSearch("")}>
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {nextActionDraw ? (
            <Button variant="outline" size="sm" onClick={() => handleGenerateInvoice(nextActionDraw)} disabled={saving || Boolean(generatingInvoiceDrawId)}>
              {generatingInvoiceDrawId === nextActionDraw.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ReceiptText className="mr-2 h-4 w-4" />}
              {generatingInvoiceDrawId === nextActionDraw.id ? "Creating draft" : "Prepare next draw"}
            </Button>
          ) : null}
          <Button onClick={openCreate} size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Add draw
          </Button>
        </div>
      </div>

      <div>
        {filteredDraws.length === 0 ? (
          <div className="mx-4 my-4 flex min-h-48 flex-col items-center justify-center rounded-md border border-dashed bg-muted/10 text-center sm:mx-6 lg:mx-8">
            <p className="text-sm font-medium">{search ? "No draws match your search." : "No draws scheduled yet."}</p>
            <p className="mt-1 text-xs text-muted-foreground">Create a contract-based draw schedule to start controlling project cash-in.</p>
            {!search ? (
              <Button className="mt-4" size="sm" onClick={openCreate}>
                <Plus className="mr-2 h-4 w-4" />
                Add first draw
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="bg-background">
            <div className="hidden grid-cols-[72px_minmax(180px,1fr)_minmax(220px,1.15fr)_minmax(150px,.75fr)_112px_120px_132px] border-b bg-muted/30 px-4 py-2 text-[11px] font-semibold uppercase text-muted-foreground sm:px-6 lg:grid lg:px-8">
              <div>Draw</div>
              <div>Scope</div>
              <div>Description</div>
              <div>Trigger</div>
              <div>Status</div>
              <div className="text-right">Amount</div>
              <div className="text-right" />
            </div>

            {filteredDraws.map((draw) => {
              const status = statusMap[draw.status] ?? statusMap.pending
              const amount = effectiveAmountCents(draw)
              const dueLabel = drawDueLabel(draw)

              const hasInvoice = !!draw.invoice_id
              const canInvoice = draw.status === "pending" && !hasInvoice
              const canDelete = draw.status === "pending" && !hasInvoice
              const locked = hasInvoice || draw.status !== "pending"
              const deposit = isDepositDraw(draw)

              return (
                <div
                  key={draw.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedDraw(draw)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      setSelectedDraw(draw)
                    }
                  }}
                  className="grid cursor-pointer gap-2 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-6 lg:grid-cols-[72px_minmax(180px,1fr)_minmax(220px,1.15fr)_minmax(150px,.75fr)_112px_120px_132px] lg:items-center lg:px-8"
                >
                  <div className="flex items-center gap-3 lg:block">
                    <div
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-md border text-sm font-semibold tabular-nums",
                        deposit ? "border-primary/30 bg-primary/10 text-primary" : "bg-muted/40",
                      )}
                    >
                      {deposit ? <ReceiptText className="h-4 w-4" /> : draw.draw_number}
                    </div>
                    <Badge className={cn("lg:hidden", status.tone)} variant="secondary">
                      {status.label}
                    </Badge>
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold">{draw.title}</p>
                      {deposit ? (
                        <Badge variant="outline" className="rounded-sm border-primary/30 text-primary">
                          Deposit
                        </Badge>
                      ) : null}
                      {locked ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                          <LockKeyhole className="h-3 w-3" />
                          Locked
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground lg:hidden">{draw.description || "No description"}</p>
                  </div>

                  <div className="hidden min-w-0 text-xs text-muted-foreground lg:block">
                    <p className="line-clamp-2">{draw.description || "No description"}</p>
                  </div>

                  <div className="text-xs">
                    <p className="font-medium text-foreground">{dueLabel}</p>
                    <p className="mt-1 text-muted-foreground capitalize">{draw.due_trigger ?? "manual"}</p>
                  </div>

                  <div>
                    <Badge className={cn("w-fit rounded-sm", status.tone)} variant="secondary">
                      {status.label}
                    </Badge>
                  </div>

                  <div className="text-left lg:text-right">
                    <p className="text-sm font-semibold tabular-nums">{formatCurrency(amount)}</p>
                    <p className="text-xs text-muted-foreground">{drawBasisLabel(draw)}</p>
                  </div>

                  <div className="flex items-center justify-start gap-2 lg:justify-end" onClick={(event) => event.stopPropagation()}>
                    {canInvoice ? (
                      <Button size="sm" className="h-8" onClick={() => handleGenerateInvoice(draw)} disabled={saving || Boolean(generatingInvoiceDrawId)}>
                        {generatingInvoiceDrawId === draw.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        {generatingInvoiceDrawId === draw.id ? "Creating" : "Invoice"}
                      </Button>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 border">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => openEdit(draw)} disabled={saving || Boolean(generatingInvoiceDrawId) || locked}>
                          <FileText className="mr-2 h-4 w-4" />
                          Edit draw
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleMove(draw, "up")} disabled={saving || deposit || draw.id === firstMovableId}>
                          <ArrowUp className="mr-2 h-4 w-4" />
                          Move up
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleMove(draw, "down")} disabled={saving || deposit || draw.id === lastMovableId}>
                          <ArrowDown className="mr-2 h-4 w-4" />
                          Move down
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handleGenerateInvoice(draw)} disabled={saving || Boolean(generatingInvoiceDrawId) || !canInvoice}>
                          {generatingInvoiceDrawId === draw.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ReceiptText className="mr-2 h-4 w-4" />}
                          {generatingInvoiceDrawId === draw.id ? "Creating invoice" : "Generate invoice"}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleGeneratePayApplication(draw)} disabled={Boolean(generatingPayAppDrawId)}>
                          {generatingPayAppDrawId === draw.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileText className="mr-2 h-4 w-4" />}
                          {generatingPayAppDrawId === draw.id ? "Generating…" : "Pay application (G702)"}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => handleDelete(draw)} disabled={saving || !canDelete}>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })}
          </div>
        )}

      </div>

      <DrawDetailSheet
        draw={selectedDraw}
        status={selectedDraw ? statusMap[selectedDraw.status] ?? statusMap.pending : statusMap.pending}
        amount={selectedDraw ? effectiveAmountCents(selectedDraw) : 0}
        basis={selectedDraw ? drawBasisLabel(selectedDraw) : ""}
        dueLabel={selectedDraw ? drawDueLabel(selectedDraw) : ""}
        costCodes={costCodes ?? []}
        linkedInvoice={linkedInvoice}
        linkedInvoiceLoading={linkedInvoiceLoading}
        saving={saving || Boolean(generatingInvoiceDrawId)}
        generatingInvoice={selectedDraw ? generatingInvoiceDrawId === selectedDraw.id : false}
        onOpenChange={(open) => {
          if (!open) setSelectedDraw(null)
        }}
        onEdit={(draw) => openEdit(draw)}
        onInvoice={(draw) => handleGenerateInvoice(draw)}
        onDelete={(draw) => handleDelete(draw)}
        onOpenInvoice={openLinkedInvoiceDetail}
        onLinkInvoice={openLinkPicker}
        onUnlinkInvoice={handleUnlinkInvoice}
        unlinking={unlinking}
      />

      <LinkInvoiceDialog
        open={linkPickerOpen}
        onOpenChange={setLinkPickerOpen}
        loading={linkableLoading}
        invoices={linkableInvoices}
        linkingInvoiceId={linkingInvoiceId}
        onLink={handleLinkInvoice}
      />

      <InvoiceDetailSheet
        open={invoiceDetailOpen}
        onOpenChange={setInvoiceDetailOpen}
        invoice={linkedInvoice}
        link={linkedInvoiceLink}
        views={linkedInvoiceViews}
        syncHistory={linkedInvoiceSyncHistory}
        loading={linkedInvoiceLoading}
        manualResyncing={invoiceResyncing}
        onCopyLink={async () => {
          if (linkedInvoiceLink && typeof navigator !== "undefined" && navigator.clipboard) {
            await navigator.clipboard.writeText(linkedInvoiceLink)
            toast.success("Link copied")
          }
        }}
        onManualResync={async () => {
          if (!linkedInvoice) return
          setInvoiceResyncing(true)
          try {
            unwrapAction(await manualResyncInvoiceAction(linkedInvoice.id))
            toast.success("Resync enqueued")
            await loadLinkedInvoice(linkedInvoice.id)
          } catch (err: any) {
            toast.error("Failed to resync", { description: err?.message ?? "Please try again." })
          } finally {
            setInvoiceResyncing(false)
          }
        }}
        onPaymentRecorded={async () => {
          await refreshDrawsAndLinkedInvoice(linkedInvoice?.id)
        }}
      />

      <DrawDialog
        open={isDialogOpen}
        onOpenChange={(next) => {
          setIsDialogOpen(next)
          if (!next) setEditing(null)
        }}
        saving={saving}
        depositExists={hasDeposit}
        defaultDraw={editing}
        revisedContractCents={revisedContractCents}
        scheduleItems={normalizedScheduleItems}
        costCodes={costCodes ?? []}
        onSave={handleSave}
      />
    </div>
  )
}

function DrawDetailSheet({
  draw,
  status,
  amount,
  basis,
  dueLabel,
  costCodes,
  linkedInvoice,
  linkedInvoiceLoading,
  saving,
  generatingInvoice,
  unlinking,
  onOpenChange,
  onEdit,
  onInvoice,
  onDelete,
  onOpenInvoice,
  onLinkInvoice,
  onUnlinkInvoice,
}: {
  draw: DrawSchedule | null
  status: { label: string; tone: string }
  amount: number
  basis: string
  dueLabel: string
  costCodes: CostCode[]
  linkedInvoice?: Invoice | null
  linkedInvoiceLoading?: boolean
  saving: boolean
  generatingInvoice: boolean
  unlinking: boolean
  onOpenChange: (open: boolean) => void
  onEdit: (draw: DrawSchedule) => void
  onInvoice: (draw: DrawSchedule) => void
  onDelete: (draw: DrawSchedule) => void
  onOpenInvoice: () => void
  onLinkInvoice: () => void
  onUnlinkInvoice: () => void
}) {
  const allocations = ((draw?.metadata as any)?.allocations ?? []) as { cost_code_id: string; amount_cents: number; description?: string }[]
  const costCodeById = useMemo(() => new Map(costCodes.map((code) => [code.id, code])), [costCodes])
  const hasInvoice = Boolean(draw?.invoice_id)
  const canInvoice = draw?.status === "pending" && !hasInvoice
  const canDelete = draw?.status === "pending" && !hasInvoice
  const locked = Boolean(draw && (hasInvoice || draw.status !== "pending"))
  const deposit = Boolean(draw && isDepositDraw(draw))
  const linkedInvoiceTotal = linkedInvoice?.total_cents ?? linkedInvoice?.totals?.total_cents ?? 0
  const linkedInvoiceBalance =
    linkedInvoice?.balance_due_cents ?? linkedInvoice?.totals?.balance_due_cents ?? linkedInvoiceTotal

  return (
    <Sheet open={!!draw} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col overflow-hidden p-0 shadow-2xl sm:max-w-xl">
        {draw ? (
          <>
            <SheetHeader className="border-b bg-muted/20 px-6 py-5 text-left">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="mb-2 flex items-center gap-2">
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-md border font-semibold tabular-nums",
                        deposit ? "border-primary/30 bg-primary/10 text-primary" : "bg-background",
                      )}
                    >
                      {deposit ? <ReceiptText className="h-4 w-4" /> : draw.draw_number}
                    </span>
                    {deposit ? (
                      <Badge variant="outline" className="rounded-sm border-primary/30 text-primary">
                        Deposit
                      </Badge>
                    ) : null}
                    <Badge className={cn("rounded-sm", status.tone)} variant="secondary">
                      {status.label}
                    </Badge>
                    {locked ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                        <LockKeyhole className="h-3 w-3" />
                        Locked
                      </span>
                    ) : null}
                  </div>
                  <SheetTitle className="truncate text-xl">{draw.title}</SheetTitle>
                  <SheetDescription className="mt-1 line-clamp-2">
                    {draw.description || "No description provided."}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="grid grid-cols-2 gap-3">
                <DetailStat label="Amount" value={formatCurrency(amount)} />
                <DetailStat label="Basis" value={basis} />
                <DetailStat label="Trigger" value={dueLabel} />
                <DetailStat label="Mode" value={String(draw.due_trigger ?? "manual").replaceAll("_", " ")} />
              </div>

              <div className="mt-6 border-t pt-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Cost code allocation</h3>
                  <span className="text-xs text-muted-foreground">{allocations.length || "No"} line{allocations.length === 1 ? "" : "s"}</span>
                </div>
                {allocations.length > 0 ? (
                  <div className="overflow-hidden rounded-md border">
                    {allocations.map((allocation, index) => {
                      const code = costCodeById.get(allocation.cost_code_id)
                      return (
                        <div key={`${allocation.cost_code_id}-${index}`} className="grid grid-cols-[minmax(0,1fr)_120px] gap-3 border-b px-3 py-3 last:border-b-0">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {code ? `${code.code} ${code.name ?? ""}`.trim() : "Uncoded"}
                            </p>
                            {allocation.description ? (
                              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{allocation.description}</p>
                            ) : null}
                          </div>
                          <p className="text-right text-sm font-semibold tabular-nums">{formatCurrency(allocation.amount_cents)}</p>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-sm text-muted-foreground">
                    This draw is not split across cost codes.
                  </div>
                )}
              </div>

              {hasInvoice ? (
                <div className="mt-6 rounded-md border bg-muted/10 px-4 py-3">
                  {linkedInvoiceLoading ? (
                    <div className="space-y-2">
                      <div className="h-4 w-28 animate-pulse rounded bg-muted" />
                      <div className="h-3 w-44 animate-pulse rounded bg-muted" />
                    </div>
                  ) : linkedInvoice ? (
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <ReceiptText className="h-4 w-4 text-muted-foreground" />
                          <span className="truncate">Invoice {linkedInvoice.invoice_number}</span>
                          <Badge variant="secondary" className="rounded-sm capitalize">
                            {linkedInvoice.status}
                          </Badge>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatCurrency(linkedInvoiceTotal)} total · {formatCurrency(linkedInvoiceBalance)} balance
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="outline" onClick={onOpenInvoice}>
                          View invoice
                        </Button>
                        <Button size="sm" variant="ghost" onClick={onUnlinkInvoice} disabled={unlinking} title="Unlink invoice from this draw">
                          {unlinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                          <span className="sr-only">Unlink invoice</span>
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <ReceiptText className="h-4 w-4 text-muted-foreground" />
                          Invoice linked
                        </div>
                        <p className="mt-1 break-all text-xs text-muted-foreground">Invoice ID: {draw.invoice_id}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="outline" onClick={onOpenInvoice}>
                          Open
                        </Button>
                        <Button size="sm" variant="ghost" onClick={onUnlinkInvoice} disabled={unlinking} title="Unlink invoice from this draw">
                          {unlinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                          <span className="sr-only">Unlink invoice</span>
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : canInvoice ? (
                <div className="mt-6 flex flex-col gap-3 rounded-md border border-dashed bg-muted/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Link2 className="h-4 w-4 text-muted-foreground" />
                      Already invoiced outside this draw?
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Attach an existing invoice (including one imported from QuickBooks) instead of generating a new one.
                    </p>
                  </div>
                  <Button size="sm" variant="outline" className="shrink-0" onClick={onLinkInvoice} disabled={saving}>
                    <Link2 className="mr-2 h-4 w-4" />
                    Link existing invoice
                  </Button>
                </div>
              ) : null}
            </div>

            <SheetFooter className="grid grid-cols-2 gap-3 border-t bg-muted/10 p-6 sm:grid-cols-3">
              <Button variant="outline" onClick={() => onEdit(draw)} disabled={saving || locked}>
                Edit
              </Button>
              <Button onClick={() => onInvoice(draw)} disabled={saving || !canInvoice}>
                {generatingInvoice ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {generatingInvoice ? "Creating draft" : "Prepare invoice"}
              </Button>
              <Button variant="destructive" onClick={() => onDelete(draw)} disabled={saving || !canDelete}>
                Delete
              </Button>
            </SheetFooter>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold capitalize tabular-nums">{value}</p>
    </div>
  )
}

function LinkInvoiceDialog({
  open,
  onOpenChange,
  loading,
  invoices,
  linkingInvoiceId,
  onLink,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  loading: boolean
  invoices: LinkableInvoice[]
  linkingInvoiceId: string | null
  onLink: (invoiceId: string) => void
}) {
  const [search, setSearch] = useState("")

  useEffect(() => {
    if (!open) setSearch("")
  }, [open])

  const filtered = useMemo(() => {
    if (!search.trim()) return invoices
    const s = search.toLowerCase()
    return invoices.filter(
      (invoice) =>
        invoice.invoice_number.toLowerCase().includes(s) || (invoice.title ?? "").toLowerCase().includes(s),
    )
  }, [invoices, search])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link existing invoice</DialogTitle>
          <DialogDescription>
            Choose an invoice to attach to this draw. Only unlinked invoices on this project are shown.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search invoices"
            className="h-9 pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="max-h-80 overflow-y-auto rounded-md border">
          {loading ? (
            <div className="space-y-2 p-3">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {invoices.length === 0 ? "No linkable invoices on this project." : "No invoices match your search."}
            </div>
          ) : (
            filtered.map((invoice) => (
              <button
                key={invoice.id}
                type="button"
                disabled={Boolean(linkingInvoiceId)}
                onClick={() => onLink(invoice.id)}
                className="flex w-full items-center justify-between gap-4 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40 disabled:opacity-60"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">Invoice {invoice.invoice_number}</span>
                    <Badge variant="secondary" className="rounded-sm capitalize">
                      {invoice.status}
                    </Badge>
                    {invoice.from_qbo ? (
                      <Badge variant="outline" className="rounded-sm">
                        QBO
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {formatCurrency(invoice.total_cents)}
                    {invoice.linked_draw_cents > 0 ? ` · ${formatCurrency(invoice.remaining_draw_cents)} remaining for draws` : ""}
                    {invoice.title ? ` · ${invoice.title}` : ""}
                    {invoice.issue_date ? ` · ${formatLocalDate(invoice.issue_date, "MMM d, yyyy")}` : ""}
                  </p>
                </div>
                {linkingInvoiceId === invoice.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DrawDialog({
  open,
  onOpenChange,
  saving,
  depositExists,
  defaultDraw,
  revisedContractCents,
  scheduleItems,
  costCodes,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saving: boolean
  depositExists: boolean
  defaultDraw: DrawSchedule | null
  revisedContractCents: number
  scheduleItems: ScheduleItem[]
  costCodes: CostCode[]
  onSave: (input: {
    draw_number?: number
    is_deposit?: boolean
    title: string
    description?: string
    amount_mode: AmountMode
    amount_dollars?: string
    percent_of_contract?: number | null
    due_mode: DueMode
    due_date?: string | null
    milestone_id?: string | null
    due_trigger_label?: string | null
    allocations?: { cost_code_id: string; amount_cents: number; description?: string }[]
  }) => Promise<void>
}) {
  const [drawNumber, setDrawNumber] = useState<string>("")
  const [title, setTitle] = useState<string>("")
  const [description, setDescription] = useState<string>("")
  const [amountMode, setAmountMode] = useState<AmountMode>("fixed")
  const [amountDollars, setAmountDollars] = useState<string>("")
  const [percent, setPercent] = useState<string>("")
  const [dueMode, setDueMode] = useState<DueMode>("date")
  const [dueDate, setDueDate] = useState<string>("")
  const [isCalendarOpen, setIsCalendarOpen] = useState(false)
  const [milestoneId, setMilestoneId] = useState<string>("")
  const [triggerLabel, setTriggerLabel] = useState<string>("")
  const [allocations, setAllocations] = useState<{ id: string; cost_code_id: string; amount_dollars: string; description: string }[]>([])
  const [markAsDeposit, setMarkAsDeposit] = useState(false)

  // Toggling the deposit switch on a fresh draw seeds sensible deposit defaults
  // (title/timing) without clobbering anything the user already typed.
  function handleToggleDeposit(next: boolean) {
    setMarkAsDeposit(next)
    if (next) {
      setTitle((current) => current.trim() || "Deposit")
      setDueMode("approval")
      setTriggerLabel((current) => current.trim() || "On contract signing")
    }
  }

  const editingDeposit = Boolean(defaultDraw && isDepositDraw(defaultDraw))

  useEffect(() => {
    if (!open) return
    if (!defaultDraw) {
      setDrawNumber("")
      setTitle("")
      setDescription("")
      setAmountMode("fixed")
      setAmountDollars("")
      setPercent("")
      setDueMode("date")
      setDueDate("")
      setMilestoneId("")
      setTriggerLabel("")
      setAllocations([])
      setMarkAsDeposit(false)
      return
    }
    setMarkAsDeposit(isDepositDraw(defaultDraw))

    setDrawNumber(String(defaultDraw.draw_number ?? ""))
    setTitle(defaultDraw.title ?? "")
    setDescription(defaultDraw.description ?? "")
    if (typeof defaultDraw.percent_of_contract === "number") {
      setAmountMode("percent")
      setPercent(String(defaultDraw.percent_of_contract))
      setAmountDollars("")
    } else {
      setAmountMode("fixed")
      setAmountDollars(toDollars(defaultDraw.amount_cents))
      setPercent("")
    }

    const due = (defaultDraw.due_trigger as DueMode | null) ?? "date"
    setDueMode(due)
    setDueDate(defaultDraw.due_date ?? "")
    setMilestoneId(defaultDraw.milestone_id ?? "")
    setTriggerLabel(((defaultDraw.metadata as any)?.due_trigger_label as string | undefined) ?? "")
    
    const loadedAllocations = (defaultDraw.metadata as any)?.allocations as { cost_code_id: string; amount_cents: number; description?: string }[] | undefined
    if (loadedAllocations && Array.isArray(loadedAllocations)) {
      setAllocations(loadedAllocations.map(a => ({
        id: crypto.randomUUID(),
        cost_code_id: a.cost_code_id,
        amount_dollars: (a.amount_cents / 100).toFixed(2),
        description: a.description ?? ""
      })))
    } else {
      setAllocations([])
    }
  }, [open, defaultDraw])

  const parsedComputedAmountCents =
    amountMode === "percent"
      ? Math.round((revisedContractCents * (Number.parseFloat(percent || "0") || 0)) / 100)
      : parseDollarsToCents(amountDollars)

  const computedAmount = parsedComputedAmountCents > 0 ? formatCurrency(parsedComputedAmountCents) : "—"
  
  const allocatedCents = allocations.reduce((sum, a) => sum + parseDollarsToCents(a.amount_dollars), 0)
  const isFullyAllocated = allocations.length === 0 || allocatedCents === parsedComputedAmountCents

  const isValid =
    title.trim().length > 0 &&
    parsedComputedAmountCents > 0 &&
    (dueMode !== "date" || !!dueDate) &&
    isFullyAllocated

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto p-0 flex flex-col shadow-2xl border-l">
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5 text-primary" />
            {markAsDeposit ? (defaultDraw ? "Edit Deposit" : "Add Deposit") : defaultDraw ? "Edit Draw" : "Add Draw"}
          </SheetTitle>
          <SheetDescription>
            {markAsDeposit
              ? "The deposit is recorded as the up-front “Draw 0” and invoiced like any other draw."
              : "Configure the amount, timing, and cost code allocations for this draw."}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
          {/* Deposit toggle — only when creating, and only if no deposit exists yet */}
          {!defaultDraw && !depositExists ? (
            <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 px-4 py-3">
              <div className="space-y-0.5">
                <Label htmlFor="draw-is-deposit" className="text-sm font-medium">
                  Record as deposit
                </Label>
                <p className="text-xs text-muted-foreground">
                  Pins it ahead of the schedule as the up-front “Draw 0”. One deposit per project.
                </p>
              </div>
              <Switch id="draw-is-deposit" checked={markAsDeposit} onCheckedChange={handleToggleDeposit} />
            </div>
          ) : null}
          {editingDeposit ? (
            <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm font-medium text-primary">
              <ReceiptText className="h-4 w-4" />
              This is the project deposit (Draw 0).
            </div>
          ) : null}

          {/* Main Info */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Details</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={markAsDeposit ? "e.g., Deposit" : "e.g., Foundation Complete"} className="h-10" />
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Description (Optional)</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What deliverables are tied to this payment?" rows={3} />
            </div>
          </div>

          {/* Amount Grid */}
          <div className="space-y-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Value</Label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">Amount type</Label>
                <Select value={amountMode} onValueChange={(v) => setAmountMode(v as AmountMode)}>
                  <SelectTrigger className="w-full h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed amount</SelectItem>
                    <SelectItem value="percent">% of contract</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-xs">{amountMode === "percent" ? "Percentage" : "Amount"}</Label>
                {amountMode === "percent" ? (
                  <div className="relative">
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                      <span className="text-muted-foreground sm:text-sm">%</span>
                    </div>
                    <Input
                      className="pr-7 h-10"
                      inputMode="decimal"
                      value={percent}
                      onChange={(e) => setPercent(e.target.value.replace(/[^\d.]/g, ""))}
                      placeholder="e.g., 20"
                    />
                  </div>
                ) : (
                  <div className="relative">
                    <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                      <span className="text-muted-foreground sm:text-sm">$</span>
                    </div>
                    <Input
                      className="pl-7 h-10"
                      inputMode="decimal"
                      value={amountDollars}
                      onChange={(e) => setAmountDollars(e.target.value.replace(/[^\d.]/g, ""))}
                      placeholder="e.g., 25,000"
                    />
                  </div>
                )}
                <div className="text-[10px] text-muted-foreground font-medium">Calculated Total: {computedAmount}</div>
              </div>
            </div>
          </div>

          {/* Timing Grid */}
          <div className="space-y-4">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Timing</Label>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label className="text-xs">Due based on</Label>
                <Select value={dueMode} onValueChange={(v) => setDueMode(v as DueMode)}>
                  <SelectTrigger className="w-full h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="date">Specific Date</SelectItem>
                    <SelectItem value="milestone">Schedule Milestone</SelectItem>
                    <SelectItem value="approval">Custom Trigger</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 flex flex-col">
                <Label className="text-xs">
                  {dueMode === "date" ? "Due date" : dueMode === "milestone" ? "Select milestone" : "Trigger label"}
                </Label>
                {dueMode === "date" ? (
                  <Popover open={isCalendarOpen} onOpenChange={setIsCalendarOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full h-10 justify-start text-left font-normal",
                          !dueDate && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {dueDate ? formatLocalDate(dueDate, "PPP") : <span>Pick a date</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarPicker
                        mode="single"
                        selected={dueDate ? parseLocalDate(dueDate) ?? undefined : undefined}
                        onSelect={(date) => {
                          setDueDate(date ? format(date, "yyyy-MM-dd") : "")
                          setIsCalendarOpen(false)
                        }}
                        initialFocus
                      />
                    </PopoverContent>
                  </Popover>
                ) : dueMode === "milestone" ? (
                  <Select value={milestoneId || "none"} onValueChange={(v) => setMilestoneId(v === "none" ? "" : v)}>
                    <SelectTrigger className="w-full h-10">
                      <SelectValue placeholder="Select milestone" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No milestone</SelectItem>
                      {scheduleItems.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={triggerLabel}
                    onChange={(e) => setTriggerLabel(e.target.value)}
                    placeholder="e.g., Permit approved"
                    className="h-10"
                  />
                )}
              </div>
            </div>
          </div>

          {/* Allocations */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Cost Code Allocations</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs shadow-sm"
                onClick={() => setAllocations([...allocations, { id: crypto.randomUUID(), cost_code_id: "", amount_dollars: "", description: "" }])}
              >
                <Plus className="h-3 w-3 mr-1" />
                Add line
              </Button>
            </div>
            
            {allocations.length > 0 ? (
              <div className="space-y-4 rounded-xl border p-4 bg-muted/10 shadow-inner">
                <div className="space-y-4">
                  {allocations.map((a, i) => (
                    <div key={a.id} className="flex flex-col gap-3 rounded-lg border bg-background p-4 shadow-sm">
                      <div className="flex items-center gap-3">
                        <div className="flex-1">
                          <Select
                            value={a.cost_code_id}
                            onValueChange={(val) => {
                              const next = [...allocations]
                              next[i].cost_code_id = val
                              setAllocations(next)
                            }}
                          >
                            <SelectTrigger className="h-9 text-xs w-full">
                              <SelectValue placeholder="Select cost code" />
                            </SelectTrigger>
                            <SelectContent>
                              {costCodes.map((cc) => (
                                <SelectItem key={cc.id} value={cc.id} className="text-xs">
                                  {cc.code} - {cc.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="relative w-36 shrink-0">
                          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                            <span className="text-muted-foreground text-xs">$</span>
                          </div>
                          <Input
                            className="pl-7 h-9 text-xs font-semibold"
                            placeholder="0.00"
                            inputMode="decimal"
                            value={a.amount_dollars}
                            onChange={(e) => {
                              const next = [...allocations]
                              next[i].amount_dollars = e.target.value.replace(/[^\d.]/g, "")
                              setAllocations(next)
                            }}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive hover:bg-destructive/5"
                          onClick={() => {
                            const next = [...allocations]
                            next.splice(i, 1)
                            setAllocations(next)
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                      <Input
                        placeholder="Line item description..."
                        value={a.description}
                        onChange={(e) => {
                          const next = [...allocations]
                          next[i].description = e.target.value
                          setAllocations(next)
                        }}
                        className="h-8 text-xs w-full bg-muted/20 border-dashed"
                      />
                    </div>
                  ))}
                </div>
                
                <div className="flex flex-col gap-3 pt-2">
                  <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider">
                    <span className="text-muted-foreground">Allocation Balance</span>
                    <span className={isFullyAllocated ? "text-emerald-600" : "text-amber-600"}>
                      {formatCurrency(allocatedCents)} / {formatCurrency(parsedComputedAmountCents)}
                    </span>
                  </div>
                  <div className="h-2 w-full bg-muted overflow-hidden rounded-full shadow-inner">
                    <div 
                      className={cn("h-full transition-all duration-500", isFullyAllocated ? "bg-emerald-500" : "bg-amber-500")}
                      style={{ width: `${parsedComputedAmountCents > 0 ? Math.min(100, (allocatedCents / parsedComputedAmountCents) * 100) : 0}%` }}
                    />
                  </div>
                  {!isFullyAllocated && (
                    <div className="text-[10px] text-amber-600 font-bold text-right flex items-center justify-end gap-1">
                      <AlertCircle className="h-3 w-3" />
                      {formatCurrency(parsedComputedAmountCents - allocatedCents)} remaining to allocate
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 rounded-xl border border-dashed bg-muted/5">
                <p className="text-xs text-muted-foreground">No cost code allocations added yet.</p>
                <p className="text-[10px] text-muted-foreground/60 mt-1">This draw will be recorded as a single unitemized amount.</p>
              </div>
            )}
          </div>
        </div>

        <SheetFooter className="p-6 border-t bg-muted/10 grid grid-cols-2 gap-4 mt-auto">
          <Button variant="outline" className="w-full h-11" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            className="w-full h-11 shadow-lg"
            onClick={() => {
              const cleanedAllocations = allocations
                .filter((a) => a.cost_code_id && parseDollarsToCents(a.amount_dollars) > 0)
                .map((a) => ({
                  cost_code_id: a.cost_code_id,
                  amount_cents: parseDollarsToCents(a.amount_dollars),
                  description: a.description.trim() || undefined,
                }))

              onSave({
                draw_number: drawNumber ? Number.parseInt(drawNumber, 10) : undefined,
                is_deposit: markAsDeposit || undefined,
                title: title.trim(),
                description: description.trim() || undefined,
                amount_mode: amountMode,
                amount_dollars: amountDollars,
                percent_of_contract: amountMode === "percent" ? Number.parseFloat(percent || "0") : null,
                due_mode: dueMode,
                due_date: dueDate || null,
                milestone_id: milestoneId || null,
                due_trigger_label: triggerLabel || null,
                allocations: cleanedAllocations.length > 0 ? cleanedAllocations : undefined,
              })
            }}
            disabled={!isValid || saving}
          >
            {saving ? "Saving..." : "Save draw"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
