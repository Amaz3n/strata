"use client"

import { useEffect, useMemo, useState } from "react"
import type { FormEvent } from "react"

import type { BudgetLineOption, ChangeOrder, CostCode } from "@/lib/types"
import type { ChangeOrderInput } from "@/lib/validation/change-orders"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DollarSign, Plus, Sparkles, Trash2 } from "@/components/icons"

interface ChangeOrderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  onSubmit: (values: ChangeOrderInput, publish: boolean) => Promise<void>
  isSubmitting?: boolean
  isGmpProject?: boolean
  costCodes?: CostCode[]
  budgetLines?: BudgetLineOption[]
  costCodesEnabled?: boolean
  changeOrder?: ChangeOrder | null
}

type LineDraft = {
  id: string
  description: string
  costCodeId: string
  budgetLineId: string
  quantity: string
  unit: string
  unitCost: string
  allowance: string
  taxable: boolean
  gmpClassification: "inside_gmp" | "outside_gmp"
  gmpImpact: "none" | "increase_gmp" | "decrease_gmp" | "outside_gmp"
}

function newLineDraft(partial: Partial<LineDraft> = {}): LineDraft {
  return {
    id: crypto.randomUUID(),
    description: "",
    costCodeId: "",
    budgetLineId: "",
    quantity: "1",
    unit: "ea",
    unitCost: "",
    allowance: "",
    taxable: true,
    gmpClassification: "inside_gmp",
    gmpImpact: "none",
    ...partial,
  }
}

function parseMoney(value: string) {
  const normalized = value.replace(/,/g, "").trim()
  if (!normalized) return 0
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseQuantity(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function formatMoneyFromCents(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function parsePercent(value: string, max = 100) {
  const parsed = Number(value.replace(/,/g, "").trim())
  if (!Number.isFinite(parsed)) return 0
  return Math.min(max, Math.max(0, parsed))
}

function costCodeLabel(code: CostCode) {
  return [code.code, code.name].filter(Boolean).join(" - ") || "Cost code"
}

function budgetLineLabel(line: BudgetLineOption) {
  const amount = typeof line.amount_cents === "number" ? ` (${formatMoneyFromCents(line.amount_cents)})` : ""
  return `${line.description || "Budget line"}${amount}`
}

export function ChangeOrderForm({
  open,
  onOpenChange,
  projectId,
  onSubmit,
  isSubmitting,
  isGmpProject = false,
  costCodes = [],
  budgetLines = [],
  costCodesEnabled = true,
  changeOrder,
}: ChangeOrderFormProps) {
  const [title, setTitle] = useState("")
  const [daysImpact, setDaysImpact] = useState("")
  const [notes, setNotes] = useState("")
  const [terms, setTerms] = useState("")
  const [pricingDisplay, setPricingDisplay] = useState<NonNullable<ChangeOrderInput["pricing_display"]>>("itemized")
  const [taxRate, setTaxRate] = useState("")
  const [markupPercent, setMarkupPercent] = useState("")
  const [status, setStatus] = useState<ChangeOrderInput["status"]>("draft")
  const [lines, setLines] = useState<LineDraft[]>(() => [newLineDraft()])

  const [titleError, setTitleError] = useState<string | null>(null)
  const [daysImpactError, setDaysImpactError] = useState<string | null>(null)
  const [notesError, setNotesError] = useState<string | null>(null)
  const [linesError, setLinesError] = useState<string | null>(null)

  const totals = useMemo(() => {
    const subtotalCents = lines.reduce((sum, line) => {
      const quantity = parseQuantity(line.quantity)
      const unitCost = parseMoney(line.unitCost)
      const allowance = parseMoney(line.allowance)
      return sum + Math.round((quantity * unitCost + allowance) * 100)
    }, 0)
    const taxableBaseCents = lines.reduce((sum, line) => {
      if (!line.taxable) return sum
      const quantity = parseQuantity(line.quantity)
      const unitCost = parseMoney(line.unitCost)
      const allowance = parseMoney(line.allowance)
      return sum + Math.round((quantity * unitCost + allowance) * 100)
    }, 0)
    const markupCents = Math.round(subtotalCents * (parsePercent(markupPercent) / 100))
    const taxCents = Math.round(taxableBaseCents * (parsePercent(taxRate, 20) / 100))
    return {
      subtotalCents,
      markupCents,
      taxCents,
      totalCents: subtotalCents + markupCents + taxCents,
    }
  }, [lines, markupPercent, taxRate])
  const canSubmit = Boolean(projectId && title.trim() && lines.length > 0)

  const reset = () => {
    setTitle("")
    setDaysImpact("")
    setNotes("")
    setTerms("")
    setPricingDisplay("itemized")
    setTaxRate("")
    setMarkupPercent("")
    setStatus("draft")
    setLines([newLineDraft()])
    setTitleError(null)
    setDaysImpactError(null)
    setNotesError(null)
    setLinesError(null)
  }

  useEffect(() => {
    if (open && changeOrder) {
      setTitle(changeOrder.title || "")
      setDaysImpact(changeOrder.days_impact != null ? changeOrder.days_impact.toString() : "")
      setNotes(changeOrder.summary ?? changeOrder.description ?? "")
      setTerms(typeof changeOrder.metadata?.terms === "string" ? changeOrder.metadata.terms : "")
      setPricingDisplay(
        changeOrder.metadata?.display?.pricing === "subtotals" || changeOrder.metadata?.display?.pricing === "lump_sum"
          ? changeOrder.metadata.display.pricing
          : "itemized",
      )
      setTaxRate(changeOrder.totals?.tax_rate ? String(changeOrder.totals.tax_rate) : "")
      setMarkupPercent(changeOrder.totals?.markup_percent ? String(changeOrder.totals.markup_percent) : "")
      setStatus((changeOrder.status === "sent" ? "pending" : changeOrder.status) as ChangeOrderInput["status"])

      setLines(
        changeOrder.lines?.length
          ? changeOrder.lines.map((line) =>
              newLineDraft({
                description: line.description ?? "",
                costCodeId: line.cost_code_id ?? "",
                budgetLineId: line.budget_line_id ?? "",
                quantity: String(line.quantity ?? 1),
                unit: line.unit ?? "ea",
                unitCost: ((line.unit_cost_cents ?? 0) / 100).toFixed(2),
                allowance: line.allowance_cents ? (line.allowance_cents / 100).toFixed(2) : "",
                taxable: line.taxable !== false,
                gmpClassification: line.gmp_classification ?? "inside_gmp",
                gmpImpact: line.gmp_impact ?? "none",
              }),
            )
          : [newLineDraft({ description: changeOrder.title ?? "", unitCost: ((changeOrder.total_cents ?? 0) / 100).toFixed(2) })],
      )
    } else if (open) {
      reset()
    }
  }, [open, changeOrder])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    setTitleError(null)
    setDaysImpactError(null)
    setNotesError(null)
    setLinesError(null)

    let hasError = false
    const cleanTitle = title.trim()
    if (cleanTitle.length < 3) {
      setTitleError("Title must be at least 3 characters")
      hasError = true
    }

    const cleanNotes = notes.trim()
    if (cleanNotes.length > 0 && cleanNotes.length < 3) {
      setNotesError("Scope / Reason must be at least 3 characters")
      hasError = true
    }

    const impact = daysImpact.trim() === "" ? null : Number(daysImpact)
    if (impact !== null && (isNaN(impact) || impact < -365 || impact > 365)) {
      setDaysImpactError("Schedule impact must be between -365 and 365 days")
      hasError = true
    }

    if (hasError || !canSubmit) return

    const normalizedLines = lines
      .map((line) => ({
        ...line,
        description: line.description.trim(),
        quantity: parseQuantity(line.quantity),
        unitCost: parseMoney(line.unitCost),
        allowance: parseMoney(line.allowance),
      }))
      .filter((line) => line.description.length > 0 || line.unitCost !== 0 || line.allowance !== 0)

    if (normalizedLines.length === 0) {
      setLinesError("Add at least one priced line item")
      return
    }
    if (normalizedLines.some((line) => line.description.length < 2 || line.quantity <= 0)) {
      setLinesError("Each line needs a description and quantity")
      return
    }

    const payload: ChangeOrderInput = {
      project_id: projectId,
      title: cleanTitle,
      summary: cleanNotes || cleanTitle,
      description: cleanNotes || undefined,
      intro: undefined,
      terms: terms.trim() || undefined,
      pricing_display: pricingDisplay,
      days_impact: impact,
      requires_signature: changeOrder ? changeOrder.requires_signature ?? true : true,
      tax_rate: parsePercent(taxRate, 20),
      markup_percent: parsePercent(markupPercent),
      status,
      client_visible: changeOrder ? changeOrder.client_visible ?? false : false,
      lines: normalizedLines.map((line) => ({
        cost_code_id: costCodesEnabled ? line.costCodeId || undefined : undefined,
        budget_line_id: costCodesEnabled ? undefined : line.budgetLineId || undefined,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit.trim() || "ea",
        unit_cost: line.unitCost,
        allowance: line.allowance,
        taxable: line.taxable,
        gmp_classification: line.gmpClassification,
        gmp_impact: isGmpProject
          ? line.gmpClassification === "outside_gmp"
            ? "outside_gmp"
            : line.gmpImpact
          : "none",
      })),
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
              ? "Update the client-facing change order."
              : "Build a clear, client-ready change order. Send it through the portal when ready."}
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

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label className={linesError ? "text-destructive" : ""}>Line items</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setLines((current) => [...current, newLineDraft()])
                      setLinesError(null)
                    }}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    Add item
                  </Button>
                </div>
                <div className="space-y-3">
                  {lines.map((line, index) => (
                    <div key={line.id} className="space-y-3 rounded-lg border bg-background p-3">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <Input
                            value={line.description}
                            onChange={(event) => {
                              const value = event.target.value
                              setLines((current) => current.map((item) => (item.id === line.id ? { ...item, description: value } : item)))
                              if (linesError) setLinesError(null)
                            }}
                            placeholder={`Item ${index + 1} description`}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-9 w-9 text-muted-foreground"
                          disabled={lines.length === 1}
                          onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}
                        >
                          <Trash2 className="h-4 w-4" />
                          <span className="sr-only">Remove item</span>
                        </Button>
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          {costCodesEnabled ? "Cost code" : "Budget line"}
                        </Label>
                        {costCodesEnabled ? (
                          <Select
                            value={line.costCodeId || "__none__"}
                            onValueChange={(value) =>
                              setLines((current) =>
                                current.map((item) =>
                                  item.id === line.id ? { ...item, costCodeId: value === "__none__" ? "" : value } : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select cost code" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Tracking only</SelectItem>
                              {costCodes.map((code) => (
                                <SelectItem key={code.id} value={code.id}>
                                  {costCodeLabel(code)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Select
                            value={line.budgetLineId || "__none__"}
                            onValueChange={(value) =>
                              setLines((current) =>
                                current.map((item) =>
                                  item.id === line.id ? { ...item, budgetLineId: value === "__none__" ? "" : value } : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select budget line" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Tracking only</SelectItem>
                              {budgetLines.map((lineOption) => (
                                <SelectItem key={lineOption.id} value={lineOption.id}>
                                  {budgetLineLabel(lineOption)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[80px_80px_1fr_1fr]">
                        <Input
                          value={line.quantity}
                          onChange={(event) => {
                            const value = event.target.value
                            if (!/^\d*\.?\d{0,2}$/.test(value)) return
                            setLines((current) => current.map((item) => (item.id === line.id ? { ...item, quantity: value } : item)))
                          }}
                          inputMode="decimal"
                          placeholder="Qty"
                        />
                        <Input
                          value={line.unit}
                          onChange={(event) =>
                            setLines((current) => current.map((item) => (item.id === line.id ? { ...item, unit: event.target.value } : item)))
                          }
                          placeholder="Unit"
                        />
                        <div className="relative">
                          <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={line.unitCost}
                            onChange={(event) => {
                              const nextValue = event.target.value.replace(",", ".")
                              if (!/^-?\d*\.?\d{0,2}$/.test(nextValue)) return
                              setLines((current) => current.map((item) => (item.id === line.id ? { ...item, unitCost: nextValue } : item)))
                            }}
                            inputMode="decimal"
                            className="pl-9"
                            placeholder="Unit cost"
                          />
                        </div>
                        <div className="relative">
                          <DollarSign className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            value={line.allowance}
                            onChange={(event) => {
                              const nextValue = event.target.value.replace(",", ".")
                              if (!/^-?\d*\.?\d{0,2}$/.test(nextValue)) return
                              setLines((current) => current.map((item) => (item.id === line.id ? { ...item, allowance: nextValue } : item)))
                            }}
                            inputMode="decimal"
                            className="pl-9"
                            placeholder="Allowance"
                          />
                        </div>
                      </div>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={line.taxable}
                          onCheckedChange={(checked) =>
                            setLines((current) => current.map((item) => (item.id === line.id ? { ...item, taxable: checked === true } : item)))
                          }
                        />
                        Taxable
                      </label>
                      {isGmpProject ? (
                        <div className="grid gap-2 sm:grid-cols-2">
                          <Select
                            value={line.gmpClassification}
                            onValueChange={(value) =>
                              setLines((current) =>
                                current.map((item) =>
                                  item.id === line.id
                                    ? {
                                        ...item,
                                        gmpClassification: value as "inside_gmp" | "outside_gmp",
                                        gmpImpact: value === "outside_gmp" ? "outside_gmp" : item.gmpImpact === "outside_gmp" ? "none" : item.gmpImpact,
                                      }
                                    : item,
                                ),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="inside_gmp">Inside GMP</SelectItem>
                              <SelectItem value="outside_gmp">Outside GMP</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select
                            value={line.gmpClassification === "outside_gmp" ? "outside_gmp" : line.gmpImpact}
                            disabled={line.gmpClassification === "outside_gmp"}
                            onValueChange={(value) =>
                              setLines((current) =>
                                current.map((item) => (item.id === line.id ? { ...item, gmpImpact: value as LineDraft["gmpImpact"] } : item)),
                              )
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No GMP change</SelectItem>
                              <SelectItem value="increase_gmp">Increase GMP</SelectItem>
                              <SelectItem value="decrease_gmp">Decrease GMP</SelectItem>
                              {line.gmpClassification === "outside_gmp" ? (
                                <SelectItem value="outside_gmp">Outside GMP only</SelectItem>
                              ) : null}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
                {linesError ? <p className="text-xs text-destructive">{linesError}</p> : null}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Pricing display</Label>
                  <Select value={pricingDisplay} onValueChange={(value) => setPricingDisplay(value as NonNullable<ChangeOrderInput["pricing_display"]>)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="itemized">Itemized</SelectItem>
                      <SelectItem value="subtotals">Subtotals</SelectItem>
                      <SelectItem value="lump_sum">Lump sum</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Markup %</Label>
                  <Input
                    value={markupPercent}
                    onChange={(event) => {
                      const nextValue = event.target.value.replace(",", ".")
                      if (!/^\d*\.?\d{0,3}$/.test(nextValue)) return
                      if (nextValue && Number(nextValue) > 100) return
                      setMarkupPercent(nextValue)
                    }}
                    inputMode="decimal"
                    placeholder="0"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Tax %</Label>
                  <Input
                    value={taxRate}
                    onChange={(event) => {
                      const nextValue = event.target.value.replace(",", ".")
                      if (!/^\d*\.?\d{0,3}$/.test(nextValue)) return
                      if (nextValue && Number(nextValue) > 20) return
                      setTaxRate(nextValue)
                    }}
                    inputMode="decimal"
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className={daysImpactError ? "text-destructive" : ""}>Schedule impact</Label>
                  <Input
                    value={daysImpact}
                    onChange={(event) => {
                      if (!/^-?\d*$/.test(event.target.value)) return
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
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Subtotal</span>
                    <span className="tabular-nums">{formatMoneyFromCents(totals.subtotalCents)}</span>
                  </div>
                  {totals.markupCents !== 0 ? (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Markup</span>
                      <span className="tabular-nums">{formatMoneyFromCents(totals.markupCents)}</span>
                    </div>
                  ) : null}
                  {totals.taxCents !== 0 ? (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Tax</span>
                      <span className="tabular-nums">{formatMoneyFromCents(totals.taxCents)}</span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between border-t pt-2">
                    <span className="text-muted-foreground">Change order total</span>
                    <span className="font-semibold tabular-nums">{formatMoneyFromCents(totals.totalCents)}</span>
                  </div>
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
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Approval is recorded from the detail sheet once the client or offline signer has approved the change.
                  </p>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label className={notesError ? "text-destructive" : ""}>Scope / Reason</Label>
                <Textarea
                  value={notes}
                  onChange={(event) => {
                    setNotes(event.target.value)
                    if (notesError) setNotesError(null)
                  }}
                  rows={5}
                  placeholder="Describe what changed, why it changed, and what the client is approving."
                  className={notesError ? "border-destructive focus-visible:ring-destructive" : ""}
                />
                {notesError && (
                  <p className="text-xs text-destructive mt-1">{notesError}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Terms</Label>
                <Textarea
                  value={terms}
                  onChange={(event) => setTerms(event.target.value)}
                  rows={5}
                  placeholder="Approval terms, payment expectations, exclusions, or expiration language."
                />
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
