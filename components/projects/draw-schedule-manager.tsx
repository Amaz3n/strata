"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { Calendar as CalendarIcon, ArrowDown, ArrowUp, FileText, MoreHorizontal, Plus, ReceiptText, Trash2, Search, X } from "lucide-react"
import { toast } from "sonner"

import type { Contract, DrawSchedule, ScheduleItem, CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetDescription } from "@/components/ui/sheet"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"

import {
  createProjectDrawAction,
  deleteProjectDrawAction,
  generateInvoiceFromDrawAction,
  reorderProjectDrawsAction,
  updateProjectDrawAction,
} from "@/app/(app)/projects/[id]/actions"

const statusMap: Record<string, { label: string; tone: string }> = {
  pending: { label: "Pending", tone: "bg-amber-100 text-amber-700" },
  invoiced: { label: "Invoiced", tone: "bg-blue-100 text-blue-700" },
  partial: { label: "Partial", tone: "bg-purple-100 text-purple-700" },
  paid: { label: "Paid", tone: "bg-emerald-100 text-emerald-700" },
}

type AmountMode = "fixed" | "percent"
type DueMode = "date" | "milestone" | "approval"

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
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

export function DrawScheduleManager({
  projectId,
  initialDraws,
  contract,
  approvedChangeOrdersTotalCents,
  scheduleItems,
  costCodes,
  compact = false,
}: {
  projectId: string
  initialDraws: DrawSchedule[]
  contract: Contract | null
  approvedChangeOrdersTotalCents?: number
  scheduleItems?: ScheduleItem[]
  costCodes?: CostCode[]
  compact?: boolean
}) {
  const [draws, setDraws] = useState<DrawSchedule[]>(initialDraws)
  const [saving, startSaving] = useTransition()
  const [invoicingId, startInvoicing] = useTransition()
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DrawSchedule | null>(null)
  const [search, setSearch] = useState("")

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
    return (contract?.total_cents ?? 0) + (approvedChangeOrdersTotalCents ?? 0)
  }, [contract?.total_cents, approvedChangeOrdersTotalCents])

  const effectiveAmountCents = useCallback((draw: DrawSchedule) => {
    if (typeof draw.percent_of_contract === "number" && revisedContractCents > 0) {
      return Math.round((revisedContractCents * draw.percent_of_contract) / 100)
    }
    return draw.amount_cents ?? 0
  }, [revisedContractCents])

  const totals = useMemo(() => {
    const total = draws.reduce((sum, draw) => sum + effectiveAmountCents(draw), 0)
    const billed = draws
      .filter((d) => d.status === "invoiced" || d.status === "partial" || d.status === "paid")
      .reduce((sum, draw) => sum + effectiveAmountCents(draw), 0)
    return { total, billed }
  }, [draws, effectiveAmountCents])

  const progress = totals.total > 0 ? Math.round((totals.billed / totals.total) * 100) : 0
  const overContract = revisedContractCents > 0 && totals.total > revisedContractCents
  const unallocatedCents = revisedContractCents > 0 ? revisedContractCents - totals.total : 0

  function openCreate() {
    setEditing(null)
    setIsDialogOpen(true)
  }

  function openEdit(draw: DrawSchedule) {
    setEditing(draw)
    setIsDialogOpen(true)
  }

  async function handleSave(input: {
    draw_number?: number
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
          const updated = await updateProjectDrawAction(projectId, editing.id, payload)
          setDraws((prev) => prev.map((d) => (d.id === updated.id ? updated : d)).sort((a, b) => a.draw_number - b.draw_number))
          toast.success("Draw updated")
        } else {
          const created = await createProjectDrawAction(projectId, payload)
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
        await deleteProjectDrawAction(projectId, draw.id)
        setDraws((prev) => prev.filter((d) => d.id !== draw.id))
        toast.success("Draw deleted")
      } catch (err: any) {
        toast.error("Could not delete draw", { description: err?.message ?? "Please try again." })
      }
    })
  }

  async function handleMove(draw: DrawSchedule, direction: "up" | "down") {
    const idx = draws.findIndex((d) => d.id === draw.id)
    const nextIdx = direction === "up" ? idx - 1 : idx + 1
    if (idx < 0 || nextIdx < 0 || nextIdx >= draws.length) return

    const ordered = [...draws]
    const [moved] = ordered.splice(idx, 1)
    ordered.splice(nextIdx, 0, moved)

    startSaving(async () => {
      try {
        const orderedIds = ordered.map((d) => d.id)
        const updated = await reorderProjectDrawsAction(projectId, orderedIds)
        setDraws(updated)
      } catch (err: any) {
        toast.error("Could not reorder draws", { description: err?.message ?? "Please try again." })
      }
    })
  }

  async function handleGenerateInvoice(draw: DrawSchedule) {
    startInvoicing(async () => {
      try {
        const result = await generateInvoiceFromDrawAction(projectId, draw.id)
        setDraws((prev) => prev.map((d) => (d.id === result.draw.id ? result.draw : d)))
        toast.success("Invoice created", { description: `Invoice #${result.invoice_number}` })
        window.location.href = `/projects/${projectId}/invoices?open=${result.invoice_id}`
      } catch (err: any) {
        toast.error("Could not generate invoice", { description: err?.message ?? "Please try again." })
      }
    })
  }

  const filteredDraws = useMemo(() => {
    if (!search.trim()) return draws
    const s = search.toLowerCase()
    return draws.filter((d) => d.title?.toLowerCase().includes(s) || d.description?.toLowerCase().includes(s))
  }, [draws, search])

  return (
    <Card className="shadow-sm overflow-hidden border-none bg-transparent">
      <CardHeader className="px-0 pt-0 pb-4 flex flex-row items-center justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-xl font-bold">Draw Schedule</CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{formatCurrency(totals.billed)}</span>
            <span>billed of</span>
            <span className="font-medium text-foreground">{formatCurrency(totals.total)}</span>
            <span className={cn("ml-1 font-bold", overContract ? "text-destructive" : "text-primary")}>
              {progress}%
            </span>
          </div>
        </div>
        <Button onClick={openCreate} size="sm" className="shadow-sm">
          <Plus className="h-4 w-4 mr-2" />
          Add draw
        </Button>
      </CardHeader>

      <CardContent className="px-0">
        <div className="relative mb-6">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input 
            placeholder="Search draws by title or description..." 
            className="pl-10 bg-muted/20"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <Button variant="ghost" size="icon" className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7" onClick={() => setSearch("")}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="mt-6">
          {filteredDraws.length === 0 ? (
            <div className={`${compact ? "py-4 text-xs sm:text-sm" : "py-10 text-sm"} text-center border border-dashed rounded-lg text-muted-foreground bg-muted/5`}>
              {search ? "No draws match your search." : "No draws scheduled yet."}
            </div>
          ) : (
            <div className={`space-y-4 sm:space-y-6 relative before:absolute before:inset-y-0 ${compact ? "before:left-[15px]" : "before:left-[19px]"} before:w-0.5 before:bg-muted`}>
              {filteredDraws.map((draw, index) => {
                const status = statusMap[draw.status] ?? statusMap.pending
                const amount = effectiveAmountCents(draw)
                const milestone = draw.milestone_id ? milestonesById.get(draw.milestone_id) : undefined
                
                let dueLabel = "—"
                if (draw.due_trigger === "milestone") {
                  if (milestone) {
                    const projectedDate = milestone.end_date ? format(new Date(milestone.end_date), "MMM d, yyyy") : ""
                    dueLabel = `${milestone.name}${projectedDate ? ` (${projectedDate})` : ""}`
                  } else {
                    dueLabel = "Milestone"
                  }
                } else if (draw.due_date) {
                  dueLabel = format(new Date(draw.due_date), "MMM d, yyyy")
                } else if ((draw.metadata as any)?.due_trigger_label) {
                  dueLabel = (draw.metadata as any).due_trigger_label
                }

                const hasInvoice = !!draw.invoice_id
                const canInvoice = draw.status === "pending" && !hasInvoice
                const canDelete = draw.status === "pending" && !hasInvoice
                
                const dotColor = draw.status === "paid" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" : draw.status === "invoiced" || draw.status === "partial" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" : "bg-muted text-muted-foreground"

                return (
                  <div key={draw.id} className="relative flex items-start gap-3 sm:gap-4 group">
                    <div className={`relative z-10 flex ${compact ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm"} shrink-0 items-center justify-center rounded-full border-[3px] border-background ${dotColor} font-semibold shadow-sm transition-colors`}>
                      {draw.draw_number}
                    </div>

                    <div className={`flex-1 rounded-lg border bg-card ${compact ? "p-3" : "p-4"} shadow-sm transition-all hover:shadow-md`}>
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className={`flex-1 ${compact ? "space-y-0.5" : "space-y-1.5"}`}>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className={`font-semibold ${compact ? "text-xs sm:text-sm" : "text-base"}`}>{draw.title}</p>
                            <Badge className={`text-[10px] sm:text-xs font-bold uppercase tracking-wider ${status.tone}`} variant="secondary">
                              {status.label}
                            </Badge>
                            {typeof draw.percent_of_contract === "number" ? (
                              <Badge variant="outline" className="text-[10px] sm:text-xs font-normal bg-muted/20">
                                {draw.percent_of_contract}% of contract
                              </Badge>
                            ) : null}
                          </div>
                          {draw.description ? (
                            <p className={`${compact ? "text-[10px] sm:text-xs" : "text-sm"} text-muted-foreground line-clamp-2`}>{draw.description}</p>
                          ) : null}
                          <div className={`${compact ? "text-[10px]" : "text-xs"} text-muted-foreground flex flex-wrap items-center gap-1.5 mt-1`}>
                            <span className="font-medium text-foreground/80">Due:</span> 
                            <span>{dueLabel}</span>
                            {hasInvoice ? <><span className="text-muted-foreground/30">•</span><span className="text-blue-600 dark:text-blue-400 font-semibold flex items-center gap-1"><ReceiptText className="h-3 w-3" /> Invoice linked</span></> : null}
                          </div>
                        </div>

                        <div className="flex items-center sm:items-start gap-3 sm:gap-4 sm:flex-col sm:items-end w-full sm:w-auto mt-2 sm:mt-0">
                          <div className={`text-right ${compact ? "text-sm sm:text-base" : "text-lg"} font-bold tracking-tight shrink-0 tabular-nums`}>{formatCurrency(amount)}</div>
                          <div className="flex-1 sm:hidden"></div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity border">
                                <MoreHorizontal className="h-4 w-4" />
                                <span className="sr-only">Actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48 shadow-xl">
                              <DropdownMenuItem onClick={() => openEdit(draw)} disabled={saving || invoicingId}>
                                <FileText className="h-4 w-4 mr-2" />
                                Edit draw
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleMove(draw, "up")}
                                disabled={saving || index === 0}
                              >
                                <ArrowUp className="h-4 w-4 mr-2" />
                                Move up
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => handleMove(draw, "down")}
                                disabled={saving || index === filteredDraws.length - 1}
                              >
                                <ArrowDown className="h-4 w-4 mr-2" />
                                Move down
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleGenerateInvoice(draw)}
                                disabled={saving || invoicingId || !canInvoice}
                                className="text-blue-600 focus:text-blue-600 focus:bg-blue-50"
                              >
                                <ReceiptText className="h-4 w-4 mr-2" />
                                Generate invoice
                              </DropdownMenuItem>
                              {hasInvoice ? (
                                <DropdownMenuItem asChild>
                                  <a href={`/projects/${projectId}/invoices?open=${draw.invoice_id}`}>
                                    <ExternalLink className="h-4 w-4 mr-2" />
                                    Open invoice
                                  </a>
                                </DropdownMenuItem>
                              ) : null}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive focus:bg-destructive/5"
                                onClick={() => handleDelete(draw)}
                                disabled={saving || !canDelete}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}

              {!search && revisedContractCents > 0 && unallocatedCents > 0 && (
                <div className="relative flex items-start gap-3 sm:gap-4 pt-2">
                  <div className={`relative z-10 flex ${compact ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm"} shrink-0 items-center justify-center rounded-full border-[3px] border-background bg-muted/50 font-semibold text-muted-foreground shadow-sm`}>
                    +
                  </div>
                  <div className={`flex-1 rounded-lg border border-dashed bg-muted/5 ${compact ? "p-3" : "p-4"} flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-inner`}>
                    <div>
                      <p className={`font-semibold ${compact ? "text-xs sm:text-sm" : "text-sm"} text-muted-foreground`}>Unallocated Contract Balance</p>
                      <p className={`${compact ? "text-[10px]" : "text-xs"} text-muted-foreground mt-0.5 font-medium`}>
                        {formatCurrency(unallocatedCents)} remaining from the total contract of {formatCurrency(revisedContractCents)}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={openCreate} disabled={saving} className="bg-background">
                      Add final draw
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>

      <DrawDialog
        open={isDialogOpen}
        onOpenChange={(next) => {
          setIsDialogOpen(next)
          if (!next) setEditing(null)
        }}
        saving={saving}
        defaultDraw={editing}
        revisedContractCents={revisedContractCents}
        scheduleItems={normalizedScheduleItems}
        costCodes={costCodes ?? []}
        onSave={handleSave}
      />
    </Card>
  )
}

function DrawDialog({
  open,
  onOpenChange,
  saving,
  defaultDraw,
  revisedContractCents,
  scheduleItems,
  costCodes,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saving: boolean
  defaultDraw: DrawSchedule | null
  revisedContractCents: number
  scheduleItems: ScheduleItem[]
  costCodes: CostCode[]
  onSave: (input: {
    draw_number?: number
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
  const [milestoneId, setMilestoneId] = useState<string>("")
  const [triggerLabel, setTriggerLabel] = useState<string>("")
  const [allocations, setAllocations] = useState<{ id: string; cost_code_id: string; amount_dollars: string; description: string }[]>([])

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
      return
    }

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
            {defaultDraw ? "Edit Draw" : "Add Draw"}
          </SheetTitle>
          <SheetDescription>
            Configure the amount, timing, and cost code allocations for this draw.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
          {/* Main Info */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Details</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Foundation Complete" className="h-10" />
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
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        className={cn(
                          "w-full h-10 justify-start text-left font-normal",
                          !dueDate && "text-muted-foreground"
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {dueDate ? format(new Date(dueDate), "PPP") : <span>Pick a date</span>}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarPicker
                        mode="single"
                        selected={dueDate ? new Date(dueDate) : undefined}
                        onSelect={(date) => setDueDate(date ? format(date, "yyyy-MM-dd") : "")}
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

function AlertCircle({ className }: { className?: string }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width="24" 
      height="24" 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function ExternalLink({ className }: { className?: string }) {
  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width="24" 
      height="24" 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
    >
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </svg>
  )
}
