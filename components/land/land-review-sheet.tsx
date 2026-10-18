"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { decideAcquisitionApprovalAction, withdrawAcquisitionReviewAction } from "@/app/(app)/communities/land-deals/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import {
  ACQUISITION_DECISION_LABELS,
  ACQUISITION_REVIEW_STATUS_LABELS,
  diffAcquisitionSnapshots,
  type AcquisitionReviewStatus,
  type SnapshotChange,
} from "@/lib/land/diligence"
import type { AcquisitionReviewDTO } from "@/lib/services/land-opportunities"
import { cn } from "@/lib/utils"

import { money, shortDate } from "./land-format"

export const REVIEW_STATUS_TONE: Record<AcquisitionReviewStatus, string> = {
  in_review: "border-warning/40 bg-warning/10 text-warning",
  approved: "border-success/40 bg-success/10 text-success",
  rejected: "border-destructive/40 bg-destructive/10 text-destructive",
  superseded: "border-border bg-muted text-muted-foreground",
  withdrawn: "border-border bg-muted text-muted-foreground",
}

export function ReviewStatusBadge({ status }: { status: AcquisitionReviewStatus }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium uppercase tracking-wide", REVIEW_STATUS_TONE[status])}>
      {ACQUISITION_REVIEW_STATUS_LABELS[status]}
    </Badge>
  )
}

const TERM_LABELS: Record<string, string> = {
  name: "Name",
  code: "Code",
  address: "Address",
  city: "City",
  state: "State",
  county: "County",
  acreage: "Acreage",
  planned_lot_count: "Planned lots",
  purchase_price_cents: "Purchase price",
  deposit_cents: "Earnest money",
  contract_executed_on: "Contract executed",
  diligence_ends_on: "Diligence ends",
  closing_target_on: "Target closing",
}

function termValue(field: string, value: string | number | null) {
  if (value === null || value === "") return "—"
  if (field.endsWith("_cents") && typeof value === "number") return money(value)
  if (field.endsWith("_on") && typeof value === "string") return shortDate(value)
  return String(value)
}

function describeChange(change: SnapshotChange) {
  switch (change.kind) {
    case "decision":
      return `Decision changed from ${change.from} to ${change.to}`
    case "term":
      return `${TERM_LABELS[change.field] ?? change.field}: ${termValue(change.field, change.from)} → ${termValue(change.field, change.to)}`
    case "item_added":
      return `Added "${change.title}"`
    case "item_removed":
      return `Removed "${change.title}"`
    case "item_changed":
      return `"${change.title}" changed (${change.fields.join(", ").replaceAll("_", " ")})`
    case "evidence_added":
      return `Filed ${change.fileName}`
    case "evidence_removed":
      return `Unfiled ${change.fileName}`
  }
}

/**
 * One reviewed version, exactly as it was submitted: the frozen terms,
 * checklist and documents, what changed from the version before, and each
 * approver's decision bound to this version's hash. The named approver
 * decides here.
 */
export function AcquisitionReviewSheet({
  dealId,
  review,
  previous,
  viewerId,
  canWrite,
  onClose,
}: {
  dealId: string
  review: AcquisitionReviewDTO | null
  previous: AcquisitionReviewDTO | null
  viewerId: string
  canWrite: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [reason, setReason] = useState("")

  const mine = review?.approvals.find((approval) => approval.approverId === viewerId && approval.decision === "pending") ?? null
  const changes = review && previous ? diffAcquisitionSnapshots(previous.snapshot, review.snapshot) : []
  const evidenceByItem = new Map<string, string[]>()
  for (const entry of review?.snapshot.evidence ?? []) {
    evidenceByItem.set(entry.item_id, [...(evidenceByItem.get(entry.item_id) ?? []), entry.file_name])
  }

  function act(label: string, operation: () => Promise<unknown>) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(label)
        setReason("")
        router.refresh()
      } catch (error) {
        toast.error("That did not save", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <Sheet open={review !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {review ? (
          <>
            <SheetHeader className="border-b pb-3">
              <div className="flex items-center gap-2">
                <ReviewStatusBadge status={review.status} />
                <span className="microlabel">r{review.revision} · {ACQUISITION_DECISION_LABELS[review.decision]}</span>
              </div>
              <SheetTitle className="text-base">
                {ACQUISITION_DECISION_LABELS[review.decision]} — revision {review.revision}
              </SheetTitle>
              <SheetDescription>
                Submitted by {review.submittedByName} on {shortDate(review.submittedAt)}
                {review.decidedAt ? ` · closed ${shortDate(review.decidedAt)}` : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-6">
              {review.summary ? <p className="text-sm">{review.summary}</p> : null}

              {mine && review.status === "in_review" ? (
                <section className="space-y-3 border p-3">
                  <h3 className="microlabel">Your decision · {mine.label}</h3>
                  <p className="text-xs text-muted-foreground">
                    You are deciding exactly this version. If the deal changes before you decide, this version is superseded and your decision is refused.
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="review-reason">Note (required to return)</Label>
                    <Input id="review-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why, in a sentence" />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() =>
                        act("Approved", async () =>
                          unwrapAction(await decideAcquisitionApprovalAction(dealId, mine.id, { decision: "approved", reason: reason || null, contentHash: review.contentHash })),
                        )
                      }
                    >
                      Approve r{review.revision}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                      disabled={pending || reason.trim().length < 10}
                      onClick={() =>
                        act("Returned", async () =>
                          unwrapAction(await decideAcquisitionApprovalAction(dealId, mine.id, { decision: "rejected", reason, contentHash: review.contentHash })),
                        )
                      }
                    >
                      Return
                    </Button>
                  </div>
                </section>
              ) : null}

              <section className="space-y-2">
                <h3 className="microlabel">Approvals</h3>
                <div className="border">
                  <Table>
                    <TableHeader>
                      <TableRow className="microlabel">
                        <TableHead>Step</TableHead>
                        <TableHead>Approver</TableHead>
                        <TableHead>Decision</TableHead>
                        <TableHead>Decided</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {review.approvals.map((approval) => (
                        <TableRow key={approval.id} className="text-xs">
                          <TableCell className="text-muted-foreground">{approval.label}</TableCell>
                          <TableCell className="font-medium">{approval.approverName}</TableCell>
                          <TableCell>
                            <span
                              className={cn(
                                approval.decision === "approved" && "text-success",
                                approval.decision === "rejected" && "text-destructive",
                                approval.decision === "pending" && "text-muted-foreground",
                              )}
                            >
                              {approval.decision === "pending" ? "Pending" : approval.decision === "approved" ? "Approved" : "Returned"}
                            </span>
                            {approval.reason ? <span className="block text-muted-foreground">{approval.reason}</span> : null}
                          </TableCell>
                          <TableCell className="tabular-nums text-muted-foreground">
                            {approval.decidedAt ? shortDate(approval.decidedAt) : "—"}
                            {approval.reviewedHash ? <span className="block font-mono text-[10px]">{approval.reviewedHash.slice(0, 12)}</span> : null}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">Version hash {review.contentHash}</p>
              </section>

              {previous ? (
                <section className="space-y-2">
                  <h3 className="microlabel">Changed since r{previous.revision}</h3>
                  {changes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">Nothing in the terms, checklist or documents changed.</p>
                  ) : (
                    <ul className="space-y-1 text-xs">
                      {changes.map((change, index) => <li key={index}>{describeChange(change)}</li>)}
                    </ul>
                  )}
                </section>
              ) : null}

              <section className="space-y-2">
                <h3 className="microlabel">Terms reviewed</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  {Object.entries(TERM_LABELS).map(([field, label]) => (
                    <div key={field} className="flex justify-between gap-2 border-b py-1">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-right tabular-nums">{termValue(field, review.snapshot.terms[field] ?? null)}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              <section className="space-y-2">
                <h3 className="microlabel">Diligence reviewed</h3>
                {review.snapshot.items.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No checklist when this version was submitted.</p>
                ) : (
                  <ul className="divide-y border text-xs">
                    {review.snapshot.items.map((item) => (
                      <li key={item.id} className="space-y-0.5 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{item.title}</span>
                          <span className="uppercase tracking-wide text-muted-foreground">{item.status}</span>
                        </div>
                        {item.finding ? <p className="text-muted-foreground">{item.finding}</p> : null}
                        {item.waived_reason ? <p className="text-muted-foreground">Waived: {item.waived_reason}</p> : null}
                        {(evidenceByItem.get(item.id) ?? []).length > 0 ? (
                          <p className="text-muted-foreground">Evidence: {(evidenceByItem.get(item.id) ?? []).join(", ")}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {canWrite && review.status === "in_review" ? (
                <div className="border-t pt-4">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => act("Review withdrawn", async () => unwrapAction(await withdrawAcquisitionReviewAction(dealId, review.id)))}
                  >
                    Withdraw this version
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
