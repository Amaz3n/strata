"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { ArrowDown, ArrowUp, FileText, MoreHorizontal, Plus, ReceiptText } from "lucide-react"
import { toast } from "sonner"

import type { Contract, DrawSchedule, ScheduleItem } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

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
  compact = false,
}: {
  projectId: string
  initialDraws: DrawSchedule[]
  contract: Contract | null
  approvedChangeOrdersTotalCents?: number
  scheduleItems?: ScheduleItem[]
  compact?: boolean
}) {
  const [draws, setDraws] = useState<DrawSchedule[]>(initialDraws)
  const [saving, startSaving] = useTransition()
  const [invoicingId, startInvoicing] = useTransition()
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editing, setEditing] = useState<DrawSchedule | null>(null)

  const normalizedScheduleItems = useMemo(() => (Array.isArray(scheduleItems) ? scheduleItems : []), [scheduleItems])

  const milestonesById = useMemo(() => {
    const map = new Map<string, ScheduleItem>()
    for (const item of normalizedScheduleItems) {
      map.set(item.id, item)
    }
    return map
  }, [normalizedScheduleItems])

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

  return (
    <Card>
      <CardHeader className={`flex flex-row items-center justify-between ${compact ? "pb-3" : ""}`}>
        <CardTitle className={compact ? "text-sm font-semibold" : "text-base"}>Draw Schedule</CardTitle>
        <Button size="sm" onClick={openCreate} disabled={saving || invoicingId} className={compact ? "h-7 text-xs" : ""}>
          <Plus className={`${compact ? "h-3 w-3 mr-1" : "h-4 w-4 mr-2"}`} />
          Add draw
        </Button>
      </CardHeader>
      <CardContent className={compact ? "pt-0 space-y-3" : "space-y-4"}>
        <div className={compact ? "space-y-1.5" : "space-y-2"}>
          <div className={`flex items-center justify-between gap-4 ${compact ? "text-xs sm:text-sm" : "text-sm"}`}>
            <div className="text-muted-foreground">Billed vs total</div>
            <div className="font-medium">{progress}%</div>
          </div>
          <Progress value={progress} />
          {revisedContractCents > 0 ? (
            <div className={`${compact ? "text-[10px] sm:text-xs" : "text-xs"} ${overContract ? "text-destructive" : "text-muted-foreground"}`}>
              Total scheduled {formatCurrency(totals.total)} • Revised contract {formatCurrency(revisedContractCents)}
              {overContract ? " • Over contract (check draw amounts)" : ""}
            </div>
          ) : null}
        </div>

        <div className="divide-y">
          {draws.length === 0 ? (
            <div className={`${compact ? "py-4 text-xs sm:text-sm" : "py-6 text-sm"} text-muted-foreground`}>No draws scheduled yet.</div>
          ) : (
            draws.map((draw, index) => {
              const status = statusMap[draw.status] ?? statusMap.pending
              const amount = effectiveAmountCents(draw)
              const milestone = draw.milestone_id ? milestonesById.get(draw.milestone_id) : undefined
              const dueLabel =
                draw.due_trigger === "milestone"
                  ? milestone?.name ?? "Milestone"
                  : draw.due_date
                    ? format(new Date(draw.due_date), "MMM d, yyyy")
                    : (draw.metadata as any)?.due_trigger_label ?? "—"

              const hasInvoice = !!draw.invoice_id
              const canInvoice = draw.status === "pending" && !hasInvoice
              const canDelete = draw.status === "pending" && !hasInvoice

              return (
                <div key={draw.id} className={`${compact ? "py-2" : "py-3"} flex items-start gap-2 sm:gap-3`}>
                  <div className={`flex ${compact ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm"} items-center justify-center rounded-md bg-muted font-semibold`}>
                    {draw.draw_number}
                  </div>

                  <div className={`flex-1 ${compact ? "space-y-0.5" : "space-y-1"}`}>
                    <div className="flex items-center gap-2">
                      <p className={`font-medium ${compact ? "text-xs sm:text-sm" : ""}`}>{draw.title}</p>
                      <Badge className={`text-xs ${status.tone}`} variant="secondary">
                        {status.label}
                      </Badge>
                      {typeof draw.percent_of_contract === "number" ? (
                        <Badge variant="outline" className="text-xs">
                          {draw.percent_of_contract}% of contract
                        </Badge>
                      ) : null}
                    </div>
                    {draw.description ? (
                      <p className={`${compact ? "text-xs sm:text-sm" : "text-sm"} text-muted-foreground line-clamp-1`}>{draw.description}</p>
                    ) : null}
                    <div className={`${compact ? "text-[10px] sm:text-xs" : "text-xs"} text-muted-foreground flex items-center gap-2`}>
                      <span>{dueLabel}</span>
                      {hasInvoice ? <span>• Invoice linked</span> : null}
                    </div>
                  </div>

                  <div className="flex items-start gap-2">
                    <div className={`text-right ${compact ? "text-xs sm:text-sm" : "text-sm"} font-semibold min-w-[110px]`}>{formatCurrency(amount)}</div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-9 w-9">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onClick={() => openEdit(draw)} disabled={saving || invoicingId}>
                          <FileText className="h-4 w-4 mr-2" />
                          Edit
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
                          disabled={saving || index === draws.length - 1}
                        >
                          <ArrowDown className="h-4 w-4 mr-2" />
                          Move down
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => handleGenerateInvoice(draw)}
                          disabled={saving || invoicingId || !canInvoice}
                        >
                          <ReceiptText className="h-4 w-4 mr-2" />
                          Generate invoice
                        </DropdownMenuItem>
                        {hasInvoice ? (
                          <DropdownMenuItem asChild>
                            <a href={`/projects/${projectId}/invoices?open=${draw.invoice_id}`}>
                              <ReceiptText className="h-4 w-4 mr-2" />
                              Open invoice
                            </a>
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => handleDelete(draw)}
                          disabled={saving || !canDelete}
                        >
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              )
            })
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
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  saving: boolean
  defaultDraw: DrawSchedule | null
  revisedContractCents: number
  scheduleItems: ScheduleItem[]
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
  }, [open, defaultDraw])

  const computedAmount =
    amountMode === "percent"
      ? formatCurrency(Math.round((revisedContractCents * (Number.parseFloat(percent || "0") || 0)) / 100))
      : amountDollars
        ? formatCurrency(parseDollarsToCents(amountDollars))
        : "—"

  const isValid =
    title.trim().length > 0 &&
    (amountMode === "fixed" ? parseDollarsToCents(amountDollars) > 0 : (Number.parseFloat(percent) || 0) > 0) &&
    (dueMode !== "date" || !!dueDate)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{defaultDraw ? "Edit draw" : "Add draw"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Draw #</Label>
            <Input
              inputMode="numeric"
              value={drawNumber}
              onChange={(e) => setDrawNumber(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="Auto"
            />
          </div>
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Foundation complete" />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Description</Label>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional details" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Amount type</Label>
            <Select value={amountMode} onValueChange={(v) => setAmountMode(v as AmountMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Fixed amount</SelectItem>
                <SelectItem value="percent">% of contract</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{amountMode === "percent" ? "Percent of contract" : "Amount (USD)"}</Label>
            {amountMode === "percent" ? (
              <Input
                inputMode="decimal"
                value={percent}
                onChange={(e) => setPercent(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="e.g., 20"
              />
            ) : (
              <Input
                inputMode="decimal"
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                placeholder="e.g., 25000"
              />
            )}
            <div className="text-xs text-muted-foreground">Calculated: {computedAmount}</div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Due based on</Label>
            <Select value={dueMode} onValueChange={(v) => setDueMode(v as DueMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date">Date</SelectItem>
                <SelectItem value="milestone">Schedule milestone</SelectItem>
                <SelectItem value="approval">Other trigger</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>
              {dueMode === "date" ? "Due date" : dueMode === "milestone" ? "Milestone" : "Trigger label"}
            </Label>
            {dueMode === "date" ? (
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            ) : dueMode === "milestone" ? (
              <Select value={milestoneId || "none"} onValueChange={(v) => setMilestoneId(v === "none" ? "" : v)}>
                <SelectTrigger>
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
              />
            )}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {defaultDraw?.status && defaultDraw.status !== "pending" ? "Only pending draws should be edited." : null}
          </div>
          <Button
            onClick={() =>
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
              })
            }
            disabled={!isValid || saving}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
