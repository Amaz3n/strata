"use client"

import { useMemo, useState } from "react"
import type { FormEvent } from "react"

import type { ChangeOrderInput } from "@/lib/validation/change-orders"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
}: ChangeOrderFormProps) {
  const [title, setTitle] = useState("")
  const [amount, setAmount] = useState("")
  const [daysImpact, setDaysImpact] = useState("")
  const [notes, setNotes] = useState("")

  const amountCents = useMemo(() => parseAmountToCents(amount), [amount])
  const canSubmit = Boolean(projectId && title.trim() && amountCents >= 0)

  const reset = () => {
    setTitle("")
    setAmount("")
    setDaysImpact("")
    setNotes("")
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit) return

    const cleanTitle = title.trim()
    const cleanNotes = notes.trim()
    const impact = daysImpact.trim() === "" ? null : Math.max(0, Number(daysImpact) || 0)
    const amountDollars = amountCents / 100

    const payload: ChangeOrderInput = {
      project_id: projectId,
      title: cleanTitle,
      summary: cleanNotes || cleanTitle,
      description: undefined,
      days_impact: impact,
      requires_signature: true,
      tax_rate: 0,
      markup_percent: 0,
      status: "draft",
      client_visible: false,
      lines: [
        {
          description: cleanTitle,
          quantity: 1,
          unit: "change",
          unit_cost: amountDollars,
          allowance: 0,
          taxable: false,
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
            New change order
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Track the change order here. Send your company PDF for execution from Signatures.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-5 px-6 py-4">
              <div className="space-y-2">
                <Label>Title</Label>
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="e.g., Add recessed lighting"
                />
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
                  <Label>Schedule impact</Label>
                  <Input
                    value={daysImpact}
                    onChange={(event) => {
                      if (!/^\d*$/.test(event.target.value)) return
                      setDaysImpact(event.target.value)
                    }}
                    inputMode="numeric"
                    placeholder="Days"
                  />
                </div>
              </div>

              <div className="rounded-lg border bg-muted/30 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Tracked amount</span>
                  <span className="font-semibold">{formatMoneyFromCents(amountCents)}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={5}
                  placeholder="Internal notes, reason for the change, or context for your team."
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
