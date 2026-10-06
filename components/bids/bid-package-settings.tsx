"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import type { BidPackage } from "@/lib/services/bids"
import { updateBidPackageAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  DEFAULT_TZ,
  US_TIMEZONES,
  dueParts,
  zonedDueAt,
  type BidWorkbenchContext,
} from "@/components/bids/bid-workbench-helpers"

/**
 * The few things about a package that are not its scope or its trades: what
 * it's called, when bids are due, how trades price it, and what it asks of
 * them. Moving the due date tells every active bidder.
 */
export function BidPackageSettings({
  open,
  onOpenChange,
  context,
  bidPackage,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: BidWorkbenchContext
  bidPackage: BidPackage
  onSaved: (bidPackage: BidPackage) => void
}) {
  const tz = bidPackage.due_tz || DEFAULT_TZ
  const initial = dueParts(bidPackage.due_at, tz)
  const [title, setTitle] = useState(bidPackage.title)
  const [date, setDate] = useState(initial.date)
  const [time, setTime] = useState(initial.time)
  const [dueTz, setDueTz] = useState(tz)
  const [mode, setMode] = useState(bidPackage.mode)
  const [bond, setBond] = useState(bidPackage.bond_required)
  const [instructions, setInstructions] = useState(bidPackage.instructions ?? "")
  const [isSaving, startSaving] = useTransition()
  const draft = bidPackage.status === "draft"
  const live = !draft && bidPackage.status !== "cancelled"

  function save() {
    if (!title.trim()) {
      toast.error("Give the package a name")
      return
    }
    const dueAt = date ? zonedDueAt(date, time, dueTz) : null
    startSaving(async () => {
      try {
        const saved = unwrapAction(
          await updateBidPackageAction({ ...context, bidPackageId: bidPackage.id }, bidPackage.id, {
            title: title.trim(),
            due_at: dueAt,
            due_tz: dueAt ? dueTz : null,
            bond_required: bond,
            instructions: instructions.trim() || null,
            ...(draft ? { mode } : {}),
          }),
        )
        onSaved(saved)
        toast.success(live && dueAt !== bidPackage.due_at ? "Saved. Bidders were told about the new due date." : "Saved")
        onOpenChange(false)
      } catch (error) {
        toast.error("Unable to save", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle>Package settings</SheetTitle>
          <SheetDescription>What trades see before they price.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="pkg-title">Name</Label>
            <Input id="pkg-title" value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pkg-due-date">Bids due</Label>
            <div className="grid grid-cols-[1fr_7rem] gap-2">
              <Input id="pkg-due-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              <Input aria-label="Due time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </div>
            <Select value={dueTz} onValueChange={setDueTz}>
              <SelectTrigger aria-label="Timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {US_TIMEZONES.map((zone) => (
                  <SelectItem key={zone.value} value={zone.value}>{zone.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {live ? <p className="text-xs text-muted-foreground">Changing it emails every active bidder.</p> : null}
          </div>

          <div className="space-y-1.5">
            <Label>How trades price it</Label>
            <Select value={mode} onValueChange={(value) => setMode(value === "quote" ? "quote" : "tender")} disabled={!draft}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tender">Line by line against your scope</SelectItem>
                <SelectItem value="quote">One lump-sum number</SelectItem>
              </SelectContent>
            </Select>
            {!draft ? <p className="text-xs text-muted-foreground">Fixed once the package has gone out.</p> : null}
          </div>

          <label className="flex items-center justify-between gap-4">
            <span className="space-y-0.5">
              <span className="block text-sm font-medium">Bond required</span>
              <span className="block text-xs text-muted-foreground">You'll confirm the bond before awarding.</span>
            </span>
            <Switch checked={bond} onCheckedChange={setBond} />
          </label>

          <div className="space-y-1.5">
            <Label htmlFor="pkg-instructions">Instructions to bidders</Label>
            <Textarea
              id="pkg-instructions"
              rows={5}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              placeholder="Site walk times, what to include, how to qualify the bid"
            />
          </div>
        </div>
        <SheetFooter className="border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={isSaving}>{isSaving ? "Saving…" : "Save"}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
