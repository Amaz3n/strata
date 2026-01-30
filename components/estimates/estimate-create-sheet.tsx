"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"

import type { Contact, CostCode, EstimateTemplate } from "@/lib/types"
import type { EstimateInput } from "@/lib/validation/estimates"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Receipt, CalendarDays, Trash2, Plus } from "@/components/icons"
import { cn } from "@/lib/utils"

const DEFAULT_LINE = { description: "", quantity: 1, unit_cost: 0, markup_pct: 0, cost_code_id: undefined as string | undefined }

interface EstimateCreateSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contacts: Contact[]
  templates: EstimateTemplate[]
  costCodes: CostCode[]
  defaultRecipientId?: string
  onCreate: (input: EstimateInput) => Promise<void> | void
  loading?: boolean
}

export function EstimateCreateSheet({
  open,
  onOpenChange,
  contacts,
  templates,
  costCodes,
  defaultRecipientId,
  onCreate,
  loading,
}: EstimateCreateSheetProps) {
  const [recipientId, setRecipientId] = useState<string>(defaultRecipientId ?? "")
  const [templateId, setTemplateId] = useState<string>("none")
  const [title, setTitle] = useState("")
  const [summary, setSummary] = useState("")
  const [terms, setTerms] = useState("")
  const [validUntil, setValidUntil] = useState<Date | undefined>(undefined)
  const [markupPercent, setMarkupPercent] = useState<number | undefined>()
  const [taxRate, setTaxRate] = useState<number | undefined>()
  const [lines, setLines] = useState<typeof DEFAULT_LINE[]>([DEFAULT_LINE])

  const totals = useMemo(() => {
    const subtotal = lines.reduce((sum, line) => {
      const base = (line.unit_cost ?? 0) * (line.quantity ?? 1)
      const effectiveMarkup = (line.markup_pct ?? 0) || (markupPercent ?? 0)
      const markup = base * (effectiveMarkup / 100)
      return sum + base + markup
    }, 0)
    const tax = subtotal * ((taxRate ?? 0) / 100)
    return { subtotal, tax, total: subtotal + tax }
  }, [lines, markupPercent, taxRate])

  useEffect(() => {
    if (defaultRecipientId) {
      setRecipientId(defaultRecipientId)
    }
  }, [defaultRecipientId])

  useEffect(() => {
    if (templateId === "none") {
      setLines([DEFAULT_LINE])
      return
    }
    const template = templates.find((t) => t.id === templateId)
    if (!template) return
    if (!title.trim()) {
      setTitle(template.name ?? "")
    }
    const mapped = (template.lines ?? []).map((line) => ({
      description: line.description ?? "",
      quantity: line.quantity ?? 1,
      unit_cost: (line.unit_cost_cents ?? 0) / 100, // Convert cents to dollars
      markup_pct: line.markup_pct ?? 0,
      cost_code_id: line.cost_code_id ?? undefined,
    }))
    setLines(mapped.length ? mapped : [DEFAULT_LINE])
  }, [templateId, templates, title])

  const handleLineChange = (idx: number, key: keyof typeof DEFAULT_LINE, value: string) => {
    setLines((prev) =>
      prev.map((line, i) =>
        i === idx
          ? { ...line, [key]: key === "description" ? value : Number(value) || 0 }
          : line,
      ),
    )
  }

  const handleLineSelect = (idx: number, value: string) => {
    setLines((prev) =>
      prev.map((line, i) =>
        i === idx ? { ...line, cost_code_id: value === "none" ? undefined : value } : line,
      ),
    )
  }

  const addLine = () => setLines((prev) => [...prev, DEFAULT_LINE])
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx))

  const handleCreate = () => {
    if (!title.trim()) return
    const validLines = lines.filter((l) => l.description.trim())
    if (!validLines.length) return

    const payload: EstimateInput = {
      title: title.trim(),
      recipient_contact_id: recipientId || undefined,
      summary: summary || undefined,
      terms: terms || undefined,
      valid_until: validUntil ? format(validUntil, "yyyy-MM-dd") : undefined,
      markup_percent: markupPercent,
      tax_rate: taxRate,
      lines: validLines.map((line) => ({
        cost_code_id: line.cost_code_id,
        description: line.description,
        quantity: line.quantity || 1,
        unit_cost_cents: Math.round((line.unit_cost || 0) * 100), // Convert dollars to cents
        markup_pct: line.markup_pct || markupPercent || 0,
        item_type: "line",
      })),
    }

    onCreate(payload)
  }

  const resetForm = () => {
    setRecipientId(defaultRecipientId ?? "")
    setTemplateId("none")
    setTitle("")
    setSummary("")
    setTerms("")
    setValidUntil(undefined)
    setMarkupPercent(undefined)
    setTaxRate(undefined)
    setLines([DEFAULT_LINE])
  }

  return (
    <Sheet open={open} onOpenChange={(val) => { if (!val) resetForm(); onOpenChange(val) }}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            New Estimate
          </SheetTitle>
          <SheetDescription>
            Create a preconstruction estimate before starting a project.
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleCreate()
          }}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4 space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Template</Label>
                <Select value={templateId} onValueChange={setTemplateId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select template" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No template</SelectItem>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Client contact</Label>
                <Select value={recipientId} onValueChange={setRecipientId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select contact (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    {contacts.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Custom home estimate" />
              </div>
              <div className="space-y-2">
                <Label>Valid until</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !validUntil && "text-muted-foreground"
                      )}
                    >
                      <CalendarDays className="mr-2 h-4 w-4" />
                      {validUntil ? format(validUntil, "LLL dd, y") : "Pick a date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={validUntil}
                      onSelect={setValidUntil}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Summary</Label>
              <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Default markup %</Label>
                <Input
                  type="number"
                  value={markupPercent ?? ""}
                  onChange={(e) => setMarkupPercent(e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="10"
                />
              </div>
              <div className="space-y-2">
                <Label>Tax rate %</Label>
                <Input
                  type="number"
                  value={taxRate ?? ""}
                  onChange={(e) => setTaxRate(e.target.value ? Number(e.target.value) : undefined)}
                  placeholder="8.5"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Terms</Label>
              <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={4} />
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-semibold">Line items</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">Add items with quantity and unit cost</p>
                </div>
                <Button variant="outline" size="sm" onClick={addLine} type="button">
                  <Plus className="h-4 w-4 mr-2" />
                  Add item
                </Button>
              </div>

              <div className="space-y-3">
                {lines.map((line, idx) => {
                  const lineTotal = (line.unit_cost ?? 0) * (line.quantity ?? 1)
                  const effectiveMarkup = (line.markup_pct ?? 0) || (markupPercent ?? 0)
                  const lineMarkup = lineTotal * (effectiveMarkup / 100)
                  const lineSubtotal = lineTotal + lineMarkup
                  return (
                    <div key={idx} className="rounded-lg border p-4 space-y-3 bg-muted/30">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">Description</Label>
                          <Input
                            value={line.description}
                            onChange={(e) => handleLineChange(idx, "description", e.target.value)}
                            placeholder="Work description"
                            className="w-full"
                          />
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 shrink-0"
                          onClick={() => removeLine(idx)}
                          disabled={lines.length === 1}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div className="space-y-2 md:col-span-2">
                          <Label className="text-xs font-medium text-muted-foreground">Cost code</Label>
                          <Select
                            value={line.cost_code_id ?? "none"}
                            onValueChange={(value) => handleLineSelect(idx, value)}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="No cost code" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No cost code</SelectItem>
                              {(costCodes ?? []).map((code) => (
                                <SelectItem key={code.id} value={code.id}>
                                  {code.code} · {code.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">Quantity</Label>
                          <Input
                            type="number"
                            step={0.01}
                            min={0}
                            value={line.quantity}
                            onChange={(e) => handleLineChange(idx, "quantity", e.target.value)}
                            placeholder="1"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">Unit cost</Label>
                          <Input
                            type="number"
                            step={0.01}
                            min={0}
                            value={line.unit_cost}
                            onChange={(e) => handleLineChange(idx, "unit_cost", e.target.value)}
                            placeholder="0.00"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">Markup %</Label>
                          <Input
                            type="number"
                            step={0.1}
                            min={0}
                            value={line.markup_pct}
                            onChange={(e) => handleLineChange(idx, "markup_pct", e.target.value)}
                            placeholder="0"
                          />
                        </div>
                        <div className="space-y-2">
                          <Label className="text-xs font-medium text-muted-foreground">Total</Label>
                          <div className="flex h-10 items-center rounded-md border border-input bg-background px-3 text-sm font-semibold">
                            ${lineSubtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <Separator />

              <div className="rounded-lg border bg-muted/40 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Subtotal</span>
                  <span className="text-lg font-semibold">${totals.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Tax</span>
                  <span className="text-lg font-semibold">${totals.tax.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Total</span>
                  <span className="text-lg font-semibold">${totals.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>
            </div>
            </div>
          </ScrollArea>

          {/* Footer */}
          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1"
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={loading}
                className="flex-1"
              >
                {loading ? "Saving..." : "Create Estimate"}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
