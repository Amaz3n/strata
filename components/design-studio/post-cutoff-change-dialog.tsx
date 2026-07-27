"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { createPostCutoffChangeOrderAction } from "@/app/(app)/design-studio/actions"
import type { SheetGroup } from "@/lib/services/design-studio"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  group: SheetGroup
  changeFeeCents: number
  canWaiveChangeFee: boolean
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

/**
 * The buyer changed their mind after the cutoff. This does not edit the
 * selection — it raises a draft change order carrying the price delta and the
 * community's change fee, which is the only way a locked selection moves.
 */
export function PostCutoffChangeDialog({
  open,
  onOpenChange,
  projectId,
  group,
  changeFeeCents,
  canWaiveChangeFee,
}: Props) {
  const router = useRouter()
  const [selectionId, setSelectionId] = useState("")
  const [optionId, setOptionId] = useState("")
  const [waiveFee, setWaiveFee] = useState(false)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setSelectionId("")
    setOptionId("")
    setWaiveFee(false)
  }, [open])

  const category = useMemo(
    () => group.categories.find((item) => item.selectionId === selectionId) ?? null,
    [group.categories, selectionId],
  )
  const currentOption = category?.options.find((option) => option.id === category.selectedOptionId) ?? null
  const nextOption = category?.options.find((option) => option.id === optionId) ?? null
  const priceDelta =
    nextOption && category ? nextOption.priceCents - (category.priceCentsSnapshot ?? 0) : null

  function submit() {
    if (!selectionId || !optionId) {
      toast.error("Choose a category and a new option")
      return
    }
    startTransition(async () => {
      try {
        const changeOrder = unwrapAction(
          await createPostCutoffChangeOrderAction({
            projectId,
            changes: [{ selectionId, newOptionId: optionId }],
            waiveFee,
          }),
        )
        onOpenChange(false)
        toast.success("Change order drafted", {
          description: "Review and send it from the project's change orders.",
          action: {
            label: "Open",
            onClick: () => router.push(`/projects/${projectId}/change-orders?changeOrder=${changeOrder.id}`),
          },
        })
        router.refresh()
      } catch (error) {
        toast.error("Could not draft the change order", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none">
        <DialogHeader>
          <DialogTitle>Change a locked selection</DialogTitle>
          <DialogDescription>
            {group.name} closed on{" "}
            {group.cutoffDate
              ? new Date(`${group.cutoffDate}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric" })
              : "its cutoff"}
            . A change now is drafted as a change order, not an edit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="change-category">Category</Label>
            <Select
              value={selectionId}
              onValueChange={(value) => {
                setSelectionId(value)
                setOptionId("")
              }}
            >
              <SelectTrigger id="change-category" className="rounded-none">
                <SelectValue placeholder="Choose a category" />
              </SelectTrigger>
              <SelectContent>
                {group.categories.map((item) => (
                  <SelectItem key={item.selectionId} value={item.selectionId}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {currentOption && (
              <p className="text-xs text-muted-foreground">
                Currently {currentOption.name} at {money(category?.priceCentsSnapshot ?? 0)}.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="change-option">New option</Label>
            <Select value={optionId} onValueChange={setOptionId} disabled={!category}>
              <SelectTrigger id="change-option" className="rounded-none">
                <SelectValue placeholder={category ? "Choose a new option" : "Choose a category first"} />
              </SelectTrigger>
              <SelectContent>
                {(category?.options ?? [])
                  .filter((option) => option.isAvailable && option.id !== category?.selectedOptionId)
                  .map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name} — {option.priceCents === 0 ? "Included" : money(option.priceCents)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {canWaiveChangeFee && (
            <div className="flex items-center justify-between border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="waive-fee">Waive the change fee</Label>
                <p className="text-xs text-muted-foreground">Recorded in the audit log with your name.</p>
              </div>
              <Switch id="waive-fee" checked={waiveFee} onCheckedChange={setWaiveFee} />
            </div>
          )}

          <dl className="space-y-1.5 border-t pt-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Option difference</dt>
              <dd className="tabular-nums">{priceDelta === null ? "—" : money(priceDelta)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Change fee</dt>
              <dd className="tabular-nums">{waiveFee ? "Waived" : money(changeFeeCents)}</dd>
            </div>
            <div className="flex justify-between font-medium">
              <dt>Change order total</dt>
              <dd className="tabular-nums">
                {priceDelta === null ? "—" : money(priceDelta + (waiveFee ? 0 : changeFeeCents))}
              </dd>
            </div>
          </dl>
        </div>

        <DialogFooter>
          <Button type="button" disabled={pending || !optionId} className="rounded-none" onClick={submit}>
            Draft change order
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
