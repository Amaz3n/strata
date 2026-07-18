"use client"

import { useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { BidPackage } from "@/lib/services/bids"
import type { Rfi } from "@/lib/types"
import { answerBidPackageRfiAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import type { BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

interface BidQaSectionProps {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  rfis: Rfi[]
  reloadRfis: () => Promise<void>
}

export function BidQaSection({ context, bidPackage, rfis, reloadRfis }: BidQaSectionProps) {
  if (!bidPackage.project_id) {
    return (
      <div className="space-y-3">
        <h2 className="text-sm font-semibold">Q&amp;A</h2>
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Vendor questions become available once this bid belongs to a project.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold">
        Q&amp;A <span className="font-normal text-muted-foreground">{rfis.length}</span>
      </h2>
      {rfis.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No questions yet. Vendor questions submitted through the portal show up here.
        </div>
      ) : (
        <div className="space-y-2">
          {rfis.map((rfi) => (
            <RfiRow key={rfi.id} context={context} bidPackage={bidPackage} rfi={rfi} reloadRfis={reloadRfis} />
          ))}
        </div>
      )}
    </div>
  )
}

function RfiRow({
  context,
  bidPackage,
  rfi,
  reloadRfis,
}: {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  rfi: Rfi
  reloadRfis: () => Promise<void>
}) {
  const answered = rfi.status === "answered" || rfi.status === "closed" || Boolean(rfi.answered_at)
  const [body, setBody] = useState("")
  const [broadcast, setBroadcast] = useState(true)
  const [isSaving, startSaving] = useTransition()

  function handleAnswer() {
    if (!body.trim()) {
      toast.error("Enter an answer")
      return
    }
    startSaving(async () => {
      try {
        unwrapAction(
          await answerBidPackageRfiAction(
            { ...context, bidPackageId: bidPackage.id },
            {
              bid_package_id: bidPackage.id,
              rfi_id: rfi.id,
              body: body.trim(),
              broadcast_as_addendum: broadcast,
            },
          ),
        )
        setBody("")
        await reloadRfis()
        toast.success(broadcast ? "Answered and broadcast as addendum" : "Answer sent")
      } catch (error) {
        toast.error("Failed to answer", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{rfi.subject}</span>
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              {rfi.display_number ?? `#${rfi.rfi_number}`}
            </Badge>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{rfi.question}</p>
        </div>
        <Badge
          variant="outline"
          className={answered ? "bg-success/10 text-success border-success/20" : "bg-warning/10 text-warning border-warning/20"}
        >
          {answered ? "Answered" : "Open"}
        </Badge>
      </div>
      {answered ? (
        rfi.answered_at ? (
          <p className="mt-2 text-xs text-muted-foreground">Answered {format(new Date(rfi.answered_at), "MMM d, h:mm a")}</p>
        ) : null
      ) : (
        <div className="mt-3 space-y-2">
          <Textarea value={body} rows={2} placeholder="Answer this question" onChange={(event) => setBody(event.target.value)} />
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={broadcast} onCheckedChange={(value) => setBroadcast(value === true)} />
              Broadcast as addendum to all vendors
            </label>
            <Button size="sm" onClick={handleAnswer} disabled={isSaving}>
              {isSaving ? "Sending…" : "Answer"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
