"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { ReceiptText, AlertCircle } from "lucide-react"
import { releaseProjectRetainageAction } from "@/app/(app)/projects/[id]/actions"
import { Progress } from "@/components/ui/progress"

interface ReleaseRetainageSheetProps {
  projectId: string
  totalHeldCents: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReleaseRetainageSheet({
  projectId,
  totalHeldCents,
  open,
  onOpenChange,
}: ReleaseRetainageSheetProps) {
  const [isPending, startTransition] = useTransition()
  const [amountDollars, setAmountDollars] = useState("")
  const [title, setTitle] = useState("Retainage Release")
  const [notes, setNotes] = useState("")

  const amountCents = Math.round((Number.parseFloat(amountDollars) || 0) * 100)
  const isValid = amountCents > 0 && amountCents <= totalHeldCents && title.trim().length > 0

  const handleRelease = () => {
    startTransition(async () => {
      try {
        await releaseProjectRetainageAction(projectId, {
          amount_cents: amountCents,
          title: title.trim(),
          notes: notes.trim() || undefined,
        })
        toast.success("Retainage release invoice generated")
        onOpenChange(false)
        setAmountDollars("")
        setNotes("")
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const setPercent = (pct: number) => {
    const cents = Math.round(totalHeldCents * (pct / 100))
    setAmountDollars((cents / 100).toFixed(2))
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full flex flex-col p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <ReceiptText className="h-5 w-5 text-primary" />
            Release Retainage
          </SheetTitle>
          <SheetDescription>
            Create an invoice to release funds currently held as retainage.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
          {/* Summary Card */}
          <div className="rounded-xl border bg-card p-5 shadow-sm space-y-4">
            <div className="space-y-1">
              <Label className="text-xs uppercase tracking-wider text-muted-foreground">Available to Release</Label>
              <div className="text-3xl font-bold">{formatCurrency(totalHeldCents)}</div>
            </div>
            
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPercent(25)}>Release 25%</Button>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPercent(50)}>Release 50%</Button>
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setPercent(100)}>Release All</Button>
            </div>
          </div>

          <div className="space-y-6">
            <div className="space-y-2">
              <Label>Invoice Title</Label>
              <Input 
                value={title} 
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Final Retainage Release" 
              />
              <p className="text-[10px] text-muted-foreground">This will appear as the main description on the generated invoice.</p>
            </div>

            <div className="space-y-2">
              <Label>Amount to Release</Label>
              <div className="relative">
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                  <span className="text-muted-foreground sm:text-sm">$</span>
                </div>
                <Input
                  className="pl-7"
                  inputMode="decimal"
                  value={amountDollars}
                  onChange={(e) => setAmountDollars(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder="0.00"
                />
              </div>
              {amountCents > totalHeldCents && (
                <div className="flex items-center gap-1.5 text-destructive text-xs mt-1 font-medium">
                  <AlertCircle className="h-3.5 w-3.5" />
                  Amount exceeds available retainage
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>Notes (Optional)</Label>
              <Textarea 
                value={notes} 
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add any internal notes or instructions..."
                rows={4}
              />
            </div>
          </div>
        </div>

        <SheetFooter className="p-6 border-t bg-muted/10 grid grid-cols-2 gap-4">
          <Button variant="outline" className="w-full" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button 
            className="w-full" 
            disabled={!isValid || isPending}
            onClick={handleRelease}
          >
            {isPending ? "Generating..." : "Generate Invoice"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { 
    style: "currency", 
    currency: "USD", 
    maximumFractionDigits: 0 
  })
}
