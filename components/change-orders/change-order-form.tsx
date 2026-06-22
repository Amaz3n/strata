"use client"

import { useEffect, useMemo, useState } from "react"
import type { FormEvent } from "react"

import type { ChangeOrder } from "@/lib/types"
import type { ChangeOrderInput } from "@/lib/validation/change-orders"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DollarSign, Sparkles } from "@/components/icons"

interface ChangeOrderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  onSubmit: (values: ChangeOrderInput, publish: boolean) => Promise<void>
  isSubmitting?: boolean
  isGmpProject?: boolean
  changeOrder?: ChangeOrder | null
}

function parseAmountToCents(value: string) {
  const normalized = value.replace(/,/g, "").trim()
  if (!normalized) return 0
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.round(parsed * 100)
}

function formatMoneyFromCents(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function ChangeOrderForm({
  open,
  onOpenChange,
  projectId,
  onSubmit,
  isSubmitting,
  isGmpProject = false,
  changeOrder,
}: ChangeOrderFormProps) {
  const [title, setTitle] = useState("")
  const [amount, setAmount] = useState("")
  const [daysImpact, setDaysImpact] = useState("")
  const [notes, setNotes] = useState("")
  const [status, setStatus] = useState<ChangeOrderInput["status"]>("draft")
  const [gmpClassification, setGmpClassification] = useState<"inside_gmp" | "outside_gmp">("inside_gmp")
  const [gmpImpact, setGmpImpact] = useState<"none" | "increase_gmp" | "decrease_gmp" | "outside_gmp">("none")

  const [titleError, setTitleError] = useState<string | null>(null)
  const [daysImpactError, setDaysImpactError] = useState<string | null>(null)
  const [notesError, setNotesError] = useState<string | null>(null)

  const amountCents = useMemo(() => parseAmountToCents(amount), [amount])
  const canSubmit = Boolean(projectId && title.trim() && amountCents >= 0)

  const reset = () => {
    setTitle("")
    setAmount("")
    setDaysImpact("")
    setNotes("")
    setStatus("draft")
    setGmpClassification("inside_gmp")
    setGmpImpact("none")
    setTitleError(null)
    setDaysImpactError(null)
    setNotesError(null)
  }

  useEffect(() => {
    if (open && changeOrder) {
      setTitle(changeOrder.title || "")
      const totalCents = changeOrder.total_cents ?? changeOrder.totals?.total_cents ?? 0
      setAmount(totalCents > 0 ? (totalCents / 100).toString() : "")
      setDaysImpact(changeOrder.days_impact != null ? changeOrder.days_impact.toString() : "")
      setNotes(changeOrder.summary ?? changeOrder.description ?? "")
      setStatus((changeOrder.status === "sent" ? "pending" : changeOrder.status) as ChangeOrderInput["status"])

      const firstLine = changeOrder.lines?.[0]
      const financialImpact = changeOrder.metadata?.financial_impact as any
      const classification = firstLine?.gmp_classification ?? "inside_gmp"
      const impact = financialImpact?.gmp_impact ?? firstLine?.gmp_impact ?? "none"
      setGmpClassification(classification)
      setGmpImpact(impact)
    } else if (open) {
      reset()
    }
  }, [open, changeOrder])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setTitleError(null)
    setDaysImpactError(null)
    setNotesError(null)

    let hasError = false
    const cleanTitle = title.trim()
    if (cleanTitle.length < 3) {
      setTitleError("Title must be at least 3 characters")
      hasError = true
    }

    const cleanNotes = notes.trim()
    if (cleanNotes.length > 0 && cleanNotes.length < 3) {
      setNotesError("Notes must be at least 3 characters")
      hasError = true
    }

    const impact = daysImpact.trim() === "" ? null : Number(daysImpact)
    if (impact !== null && (isNaN(impact) || impact < 0 || impact > 365)) {
      setDaysImpactError("Schedule impact must be between 0 and 365 days")
      hasError = true
    }

    if (hasError || !canSubmit) return

    const amountDollars = amountCents / 100
    const resolvedGmpImpact = gmpClassification === "outside_gmp" ? "outside_gmp" : gmpImpact

    const payload: ChangeOrderInput = {
      project_id: projectId,
      title: cleanTitle,
      summary: cleanNotes || cleanTitle,
      description: undefined,
      days_impact: impact,
      requires_signature: changeOrder ? changeOrder.requires_signature ?? true : true,
      tax_rate: changeOrder ? changeOrder.totals?.tax_rate ?? 0 : 0,
      markup_percent: changeOrder ? changeOrder.totals?.markup_percent ?? 0 : 0,
      status,
      client_visible: changeOrder ? changeOrder.client_visible ?? false : false,
      lines: [
        {
          description: cleanTitle,
          quantity: 1,
          unit: "change",
          unit_cost: amountDollars,
          allowance: 0,
          taxable: false,
          gmp_classification: gmpClassification,
          gmp_impact: isGmpProject ? resolvedGmpImpact : "none",
        },
      ],
    }

    await onSubmit(payload, false)
    reset()
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) reset()
        onOpenChange(nextOpen)
      }}
    >
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {changeOrder ? "Edit change order" : "New change order"}
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            {changeOrder
              ? "Update details of your change order."
              : "Track the change order here. Send your company PDF for execution from Signatures."}
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-5 px-6 py-4">
              <div className="space-y-2">
                <Label className={titleError ? "text-destructive" : ""}>Title</Label>
                <Input
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value)
                    if (titleError) setTitleError(null)
                  }}
                  placeholder="e.g., Add recessed lighting"
                  className={titleError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {titleError && (
                  <p className="text-xs text-destructive mt-1">{titleError}</p>
                )}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Amount</Label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={amount}
                      onChange={(event) => {
                        const nextValue = event.target.value.replace(",", ".")
                        if (!/^\d*\.?\d{0,2}$/.test(nextValue)) return
                        setAmount(nextValue)
                      }}
                      inputMode="decimal"
                      className="pl-9"
                      placeholder="0.00"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className={daysImpactError ? "text-destructive" : ""}>Schedule impact</Label>
                  <Input
                    value={daysImpact}
                    onChange={(event) => {
                      if (!/^\d*$/.test(event.target.value)) return
                      setDaysImpact(event.target.value)
                      if (daysImpactError) setDaysImpactError(null)
                    }}
                    inputMode="numeric"
                    placeholder="Days"
                    className={daysImpactError ? "border-destructive focus-visible:ring-destructive" : ""}
                  />
                  {daysImpactError && (
                    <p className="text-xs text-destructive mt-1">{daysImpactError}</p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Tracked amount</span>
                  <span className="font-semibold">{formatMoneyFromCents(amountCents)}</span>
                </div>
              </div>

              {changeOrder ? (
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={status} onValueChange={(value) => setStatus(value as ChangeOrderInput["status"])}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="draft">Draft</SelectItem>
                      <SelectItem value="pending">Awaiting approval</SelectItem>
                      <SelectItem value="requested_changes">Needs changes</SelectItem>
                      <SelectItem value="approved">Approved</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Only approved change orders can be invoiced. Selecting Approved records an approval completed outside Arc.
                  </p>
                </div>
              ) : null}

              {isGmpProject ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>GMP classification</Label>
                    <Select
                      value={gmpClassification}
                      onValueChange={(value) => {
                        const next = value as "inside_gmp" | "outside_gmp"
                        setGmpClassification(next)
                        if (next === "outside_gmp") setGmpImpact("outside_gmp")
                        if (next === "inside_gmp" && gmpImpact === "outside_gmp") setGmpImpact("none")
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inside_gmp">Inside GMP</SelectItem>
                        <SelectItem value="outside_gmp">Outside GMP</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>GMP impact</Label>
                    <Select
                      value={gmpClassification === "outside_gmp" ? "outside_gmp" : gmpImpact}
                      onValueChange={(value) => setGmpImpact(value as "none" | "increase_gmp" | "decrease_gmp" | "outside_gmp")}
                      disabled={gmpClassification === "outside_gmp"}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No GMP change</SelectItem>
                        <SelectItem value="increase_gmp">Increase GMP</SelectItem>
                        <SelectItem value="decrease_gmp">Decrease GMP</SelectItem>
                        {gmpClassification === "outside_gmp" ? (
                          <SelectItem value="outside_gmp">Outside GMP only</SelectItem>
                        ) : null}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label className={notesError ? "text-destructive" : ""}>Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value)
                    if (notesError) setNotesError(null)
                  }}
                  rows={5}
                  placeholder="Internal notes, reason for the change, or context for your team."
                  className={notesError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {notesError && (
                  <p className="text-xs text-destructive mt-1">{notesError}</p>
                )}
              </div>
            </div>
          </ScrollArea>

          <SheetFooter className="flex-shrink-0 border-t bg-muted/30 px-6 py-4">
            <div className="flex w-full gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" className="flex-1" disabled={isSubmitting || !canSubmit}>
                {isSubmitting ? "Saving..." : "Save change order"}
              </Button>
            </div>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
