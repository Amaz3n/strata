"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import {
  cancelSpecDispositionAction,
  recordSpecCompletionAction,
  withdrawSpecPriceChangeAction,
} from "@/app/(app)/sales/actions"
import { SpecDispositionDialog, SpecWriteDownDialog } from "@/components/communities/spec-disposition-dialog"
import { SpecRepriceDialog } from "@/components/communities/spec-reprice-dialog"
import { MoreHorizontal } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import type { SpecPriceApprovalBand } from "@/lib/sales/spec-price-approval-thresholds"

export interface SpecHomeActionRow {
  lotId: string
  lotLabel: string
  projectId: string | null
  askingPriceCents: number | null
  incentiveCents: number
  completedAt: string | null
  completionFromBooks: boolean
  pendingChange: { id: string; proposedBy: string } | null
  disposition: { id: string; status: "proposed" | "approved"; priceCents: number; carryingCents: number; blockedReason: string | null } | null
}

type Open = "price" | "incentive" | "dispose" | "write_down" | "completion" | null

/**
 * The moves a sales manager makes on one standing spec. Each opens its own
 * dialog; the one-click ones (withdraw a waiting change, cancel a sale-off)
 * act straight from the menu.
 */
export function SpecHomeActions({
  row,
  communityId,
  currentUserId,
  bands,
}: {
  row: SpecHomeActionRow
  communityId: string
  currentUserId: string
  bands: SpecPriceApprovalBand[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState<Open>(null)
  const [isPending, startTransition] = useTransition()
  const close = (next: boolean) => {
    if (!next) setOpen(null)
  }

  function act(label: string, work: () => Promise<ActionResult<unknown>>) {
    startTransition(async () => {
      try {
        unwrapAction(await work())
        toast.success(label)
        router.refresh()
      } catch (error) {
        toast.error("That did not go through", { description: (error as Error).message })
      }
    })
  }

  const busy = Boolean(row.pendingChange || row.disposition)
  const priced = row.askingPriceCents != null
  const writeDownMissing = row.disposition?.status === "approved" && row.disposition.blockedReason !== null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" disabled={isPending}>
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Lot {row.lotLabel} actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-xs">
          <DropdownMenuItem disabled={busy || !priced} onClick={() => setOpen("price")}>Reprice</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || !priced} onClick={() => setOpen("incentive")}>Set incentive</DropdownMenuItem>
          {!row.completedAt && !row.completionFromBooks && row.projectId ? (
            <DropdownMenuItem onClick={() => setOpen("completion")}>Record completion</DropdownMenuItem>
          ) : null}
          {row.pendingChange && row.pendingChange.proposedBy === currentUserId ? (
            <DropdownMenuItem
              onClick={() => act(`Lot ${row.lotLabel}: price change withdrawn`, () => withdrawSpecPriceChangeAction(communityId, { proposalId: row.pendingChange?.id }))}
            >
              Withdraw price change
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {row.disposition ? (
            <>
              {writeDownMissing ? (
                <DropdownMenuItem onClick={() => setOpen("write_down")}>Propose write-down</DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                variant="destructive"
                onClick={() => act(`Lot ${row.lotLabel}: sale-off cancelled`, () => cancelSpecDispositionAction(communityId, { dispositionId: row.disposition?.id }))}
              >
                Cancel sale-off
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem disabled={Boolean(row.pendingChange)} onClick={() => setOpen("dispose")}>Sell off…</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {open === "price" || open === "incentive" ? (
        <SpecRepriceDialog
          kind={open}
          communityId={communityId}
          lotId={row.lotId}
          lotLabel={row.lotLabel}
          askingPriceCents={row.askingPriceCents ?? 0}
          incentiveCents={row.incentiveCents}
          bands={bands}
          open
          onOpenChange={close}
        />
      ) : null}
      {open === "dispose" ? (
        <SpecDispositionDialog communityId={communityId} lotId={row.lotId} lotLabel={row.lotLabel} askingPriceCents={row.askingPriceCents} open onOpenChange={close} />
      ) : null}
      {open === "write_down" && row.disposition ? (
        <SpecWriteDownDialog
          communityId={communityId}
          dispositionId={row.disposition.id}
          lotLabel={row.lotLabel}
          priceCents={row.disposition.priceCents}
          carryingCents={row.disposition.carryingCents}
          open
          onOpenChange={close}
        />
      ) : null}
      {open === "completion" && row.projectId ? (
        <SpecCompletionDialog communityId={communityId} projectId={row.projectId} lotLabel={row.lotLabel} onOpenChange={close} />
      ) : null}
    </>
  )
}

/** The day the home was finished (CO or final inspection). It starts the home's standing age. */
function SpecCompletionDialog({
  communityId,
  projectId,
  lotLabel,
  onOpenChange,
}: {
  communityId: string
  projectId: string
  lotLabel: string
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const today = new Date().toISOString().slice(0, 10)
  const [completedOn, setCompletedOn] = useState(today)
  const [reason, setReason] = useState("")
  const [isPending, startTransition] = useTransition()
  const valid = Boolean(completedOn) && completedOn <= today

  function save() {
    startTransition(async () => {
      try {
        unwrapAction(await recordSpecCompletionAction(communityId, { projectId, completedOn, reason: reason.trim() || undefined }))
        toast.success(`Lot ${lotLabel}: completion recorded`)
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to record the completion", { description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Record completion of lot {lotLabel}</DialogTitle>
          <DialogDescription>
            The day the home was finished (certificate of occupancy or final inspection). It starts the home&apos;s
            standing age; it is never a scheduled date.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`completion-${projectId}`} className="microlabel">Completed on</Label>
            <Input
              id={`completion-${projectId}`}
              type="date"
              max={today}
              className="h-8 rounded-none text-xs tabular-nums"
              value={completedOn}
              onChange={(event) => setCompletedOn(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`completion-note-${projectId}`} className="microlabel">Note (optional)</Label>
            <Textarea
              id={`completion-note-${projectId}`}
              className="min-h-14 rounded-none text-xs"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="CO issued by the county"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" className="rounded-none" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="rounded-none" disabled={!valid || isPending} onClick={save}>
            {isPending ? "Saving…" : "Record completion"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
