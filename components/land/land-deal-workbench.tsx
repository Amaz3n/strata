"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import {
  createCommunityFromLandOpportunityAction,
  createDiligenceItemAction,
  dropLandOpportunityAction,
  linkLandOpportunityCommunityAction,
  reopenLandOpportunityAction,
  seedDiligenceChecklistAction,
} from "@/app/(app)/communities/land-deals/actions"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
import { Paperclip, Plus } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import {
  ACQUISITION_DECISION_LABELS,
  DILIGENCE_CATEGORY_LABELS,
  DILIGENCE_CATEGORIES,
  dueTone,
  hasApprovedAcquisition,
  daysUntil,
} from "@/lib/land/diligence"
import type { LandCompanyOption, LandDealDetail, LandPersonOption } from "@/lib/services/land-opportunities"
import { cn } from "@/lib/utils"

import { DiligenceItemSheet, DiligenceStatusBadge } from "./land-diligence-item-sheet"
import { LandDealFormDialog } from "./land-deal-form-dialog"
import { LandDealStageBadge } from "./land-deal-stage-badge"
import { money, relativeDays, shortDate, TONE_CLASS } from "./land-format"
import { AcquisitionReviewSheet, ReviewStatusBadge } from "./land-review-sheet"
import { SubmitReviewDialog } from "./land-review-submit-dialog"

function categoryLabel(category: string) {
  const known = DILIGENCE_CATEGORIES.find((value) => value === category)
  return known ? DILIGENCE_CATEGORY_LABELS[known] : category
}

function Stat({ label, value, detail, className }: { label: string; value: string; detail?: string | null; className?: string }) {
  return (
    <div className="min-w-28">
      <div className="microlabel">{label}</div>
      <div className={cn("text-sm font-medium tabular-nums", className)}>{value}</div>
      {detail ? <div className="text-[11px] text-muted-foreground">{detail}</div> : null}
    </div>
  )
}

/**
 * The land deal workbench: the terms, the diligence checklist with its
 * evidence, every reviewed version of the acquisition decision, and the
 * takedowns and community the deal became. Every deal mutation lives here.
 */
export function LandDealWorkbench({
  deal,
  viewerId,
  canWrite,
  canCreateCommunity,
  people,
  companies,
  divisions,
  communities,
  today,
}: {
  deal: LandDealDetail
  viewerId: string
  canWrite: boolean
  canCreateCommunity: boolean
  people: LandPersonOption[]
  companies: LandCompanyOption[]
  divisions: Array<{ id: string; name: string }>
  communities: Array<{ id: string; name: string }>
  today: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [itemId, setItemId] = useWorkspaceParam("item")
  const [reviewId, setReviewId] = useWorkspaceParam("review")
  const [newItemOpen, setNewItemOpen] = useState(false)
  const [newItem, setNewItem] = useState({ title: "", category: "other", dueOn: "" })
  const [dropOpen, setDropOpen] = useState(false)
  const [dropReason, setDropReason] = useState("")
  const [linkCommunityId, setLinkCommunityId] = useState("")

  const live = !deal.droppedAt
  const writable = canWrite && live
  const openReview = deal.reviews.find((review) => review.status === "in_review") ?? null
  const approved = hasApprovedAcquisition(deal.reviews)
  const selectedItem = deal.items.find((item) => item.id === itemId) ?? null
  const reviewIndex = deal.reviews.findIndex((review) => review.id === reviewId)
  const selectedReview = reviewIndex >= 0 ? deal.reviews[reviewIndex] : null
  const previousReview = reviewIndex >= 0 ? deal.reviews[reviewIndex + 1] ?? null : null
  const unresolved = deal.summary.open + deal.summary.issues
  const pricePerLot = deal.purchasePriceCents != null && deal.plannedLotCount ? Math.round(deal.purchasePriceCents / deal.plannedLotCount) : null

  function act(label: string, operation: () => Promise<unknown>, after?: () => void) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(label)
        after?.()
        router.refresh()
      } catch (error) {
        toast.error("That did not save", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <div className="desk-rise space-y-8 p-4">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold">{deal.name}</h1>
          <LandDealStageBadge stage={deal.stage} />
          {deal.code ? <span className="text-xs text-muted-foreground">{deal.code}</span> : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {writable ? (
              <LandDealFormDialog
                deal={deal}
                divisions={divisions}
                people={people}
                companies={companies}
                defaultDivisionId={deal.divisionId}
                trigger={<Button size="sm" variant="outline">Edit terms</Button>}
              />
            ) : null}
            {writable && !openReview ? (
              <SubmitReviewDialog
                dealId={deal.id}
                people={people}
                viewerId={viewerId}
                openIssues={unresolved}
                trigger={<Button size="sm">Submit for review</Button>}
              />
            ) : null}
            {writable ? (
              <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setDropOpen(true)}>Drop deal</Button>
            ) : null}
            {canWrite && !live && deal.stage !== "acquired" ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => act("Deal reopened", async () => unwrapAction(await reopenLandOpportunityAction(deal.id)))}>
                Reopen deal
              </Button>
            ) : null}
          </div>
        </div>

        {deal.droppedAt ? (
          <p className="border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            Dropped {shortDate(deal.droppedAt)} — {deal.droppedReason}
          </p>
        ) : null}
        {deal.truncated ? (
          <p className="text-xs text-warning">This deal holds more records than the workbench reads at once; the oldest are not shown.</p>
        ) : null}

        <div className="flex flex-wrap gap-x-8 gap-y-3 border-y py-3">
          <Stat label="Price" value={money(deal.purchasePriceCents)} detail={pricePerLot != null ? `${money(pricePerLot)} / lot` : null} />
          <Stat label="Lots" value={deal.plannedLotCount != null ? String(deal.plannedLotCount) : "—"} detail={deal.acreage != null ? `${deal.acreage} ac` : null} />
          <Stat
            label="Earnest money"
            value={money(deal.depositCents)}
            detail={deal.pressure.depositAtRiskCents > 0 ? "at risk" : null}
            className={deal.pressure.depositAtRiskCents > 0 ? "text-destructive" : undefined}
          />
          <Stat
            label="Diligence ends"
            value={shortDate(deal.diligenceEndsOn)}
            detail={relativeDays(deal.pressure.daysToDiligenceEnd)}
            className={TONE_CLASS[deal.pressure.tone]}
          />
          <Stat label="Contract" value={shortDate(deal.contractExecutedOn)} />
          <Stat label="Target closing" value={shortDate(deal.closingTargetOn)} />
          <Stat label="Lead" value={deal.leadName ?? "—"} />
          <Stat label="Division" value={deal.divisionName ?? "—"} />
          <Stat label="Seller" value={deal.sellerName ?? "—"} detail={[deal.city, deal.county, deal.state].filter(Boolean).join(", ") || null} />
        </div>
        {deal.notes ? <p className="max-w-3xl whitespace-pre-line text-sm text-muted-foreground">{deal.notes}</p> : null}
      </header>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="microlabel">Diligence</h2>
            <p className="text-xs text-muted-foreground tabular-nums">
              {deal.summary.total === 0
                ? "No checklist yet."
                : `${deal.summary.satisfied + deal.summary.waived} of ${deal.summary.total} resolved`}
              {deal.summary.issues > 0 ? <span className="ml-2 text-destructive">{deal.summary.issues} issue{deal.summary.issues === 1 ? "" : "s"}</span> : null}
              {deal.summary.overdue > 0 ? <span className="ml-2 font-medium text-destructive">{deal.summary.overdue} overdue</span> : null}
            </p>
          </div>
          {writable ? (
            <div className="flex gap-2">
              {deal.items.length === 0 ? (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => act("Checklist started", async () => unwrapAction(await seedDiligenceChecklistAction(deal.id)))}>
                  Start from the standard checklist
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => { setNewItem({ title: "", category: "other", dueOn: "" }); setNewItemOpen(true) }}>
                <Plus className="mr-1.5 h-4 w-4" />Item
              </Button>
            </div>
          ) : null}
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="microlabel">
                <TableHead>Item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Evidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deal.items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                    No diligence items. Title, survey, environmental and the rest each get an owner, a due date and their evidence.
                  </TableCell>
                </TableRow>
              ) : (
                deal.items.map((item) => {
                  const tone = dueTone(item.dueOn, item.status, today)
                  return (
                    <TableRow
                      key={item.id}
                      className={cn("cursor-pointer text-xs", itemId === item.id && "bg-accent")}
                      onClick={() => setItemId(item.id)}
                    >
                      <TableCell className="font-medium">
                        {item.title}
                        {item.finding ? <span className="block max-w-96 truncate font-normal text-muted-foreground">{item.finding}</span> : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{categoryLabel(item.category)}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.ownerName ?? "—"}
                        {item.ownerCompanyName ? <span className="block">{item.ownerCompanyName}</span> : null}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        <span className="text-muted-foreground">{shortDate(item.dueOn)}</span>
                        {tone !== "none" && item.dueOn ? <span className={cn("ml-1.5", TONE_CLASS[tone])}>{relativeDays(daysUntil(item.dueOn, today))}</span> : null}
                      </TableCell>
                      <TableCell><DiligenceStatusBadge status={item.status} /></TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {item.evidence.length > 0 ? (
                          <span className="inline-flex items-center gap-1"><Paperclip className="h-3 w-3" />{item.evidence.length}</span>
                        ) : "—"}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="microlabel">Acquisition reviews</h2>
          <p className="text-xs text-muted-foreground">Each submitted version is frozen with what it decided. Approvers decide a version, never a moving deal.</p>
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="microlabel">
                <TableHead>Version</TableHead>
                <TableHead>Decision</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Approvals</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deal.reviews.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-xs text-muted-foreground">
                    Not submitted yet. Submit the deal when diligence supports a decision.
                  </TableCell>
                </TableRow>
              ) : (
                deal.reviews.map((review) => {
                  const approvedCount = review.approvals.filter((approval) => approval.decision === "approved").length
                  const waitingOnMe = review.status === "in_review" && review.approvals.some((approval) => approval.approverId === viewerId && approval.decision === "pending")
                  return (
                    <TableRow
                      key={review.id}
                      className={cn("cursor-pointer text-xs", reviewId === review.id && "bg-accent")}
                      onClick={() => setReviewId(review.id)}
                    >
                      <TableCell className="font-medium tabular-nums">
                        r{review.revision}
                        {waitingOnMe ? <span className="ml-2 text-[11px] font-medium text-primary">Your decision</span> : null}
                      </TableCell>
                      <TableCell>{ACQUISITION_DECISION_LABELS[review.decision]}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{review.submittedByName} · {shortDate(review.submittedAt)}</TableCell>
                      <TableCell><ReviewStatusBadge status={review.status} /></TableCell>
                      <TableCell className="text-right tabular-nums">{approvedCount}/{review.approvals.length}</TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <div className="mb-3">
          <h2 className="microlabel">Community and takedowns</h2>
          <p className="text-xs text-muted-foreground">What the deal became. Takedowns are recorded and closed on the community&apos;s Land tab.</p>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
          {deal.communityId ? (
            <>
              <span className="text-muted-foreground">Community</span>
              <Link href={`/communities/${deal.communityId}/land`} className="font-medium hover:underline">{deal.communityName ?? "Open community"}</Link>
            </>
          ) : approved && writable && canCreateCommunity ? (
            <>
              <Button size="sm" disabled={pending} onClick={() => act("Community created", async () => {
                const created = unwrapAction(await createCommunityFromLandOpportunityAction(deal.id))
                router.push(`/communities/${created.communityId}/land`)
              })}>
                Create community
              </Button>
              {communities.length > 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">or add to</span>
                  <Select value={linkCommunityId} onValueChange={setLinkCommunityId}>
                    <SelectTrigger className="h-8 w-56"><SelectValue placeholder="An existing community" /></SelectTrigger>
                    <SelectContent>
                      {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !linkCommunityId}
                    onClick={() => act("Community linked", async () => unwrapAction(await linkLandOpportunityCommunityAction(deal.id, linkCommunityId)))}
                  >
                    Link
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {approved ? "No community linked yet." : "A community is opened once an acquisition review is approved."}
            </span>
          )}
        </div>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="microlabel">
                <TableHead>Takedown</TableHead>
                <TableHead>Scheduled → actual</TableHead>
                <TableHead className="text-right">Lots</TableHead>
                <TableHead className="text-right">Contract value</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deal.takedowns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-xs text-muted-foreground">No takedowns linked to this deal.</TableCell>
                </TableRow>
              ) : (
                deal.takedowns.map((takedown) => (
                  <TableRow key={takedown.id} className="text-xs">
                    <TableCell className="font-medium">
                      <Link href={`/communities/${takedown.communityId}/land`} className="hover:underline">{takedown.name}</Link>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {shortDate(takedown.scheduledDate)}
                      {takedown.actualDate ? <span className="text-foreground"> → {shortDate(takedown.actualDate)}</span> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{takedown.lotCount}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {takedown.pricePerLotCents != null ? money(takedown.pricePerLotCents * takedown.lotCount) : "—"}
                    </TableCell>
                    <TableCell><CommunityStatusBadge status={takedown.status} /></TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <DiligenceItemSheet
        dealId={deal.id}
        item={selectedItem}
        people={people}
        companies={companies}
        canWrite={writable}
        onClose={() => setItemId(null)}
      />
      <AcquisitionReviewSheet
        dealId={deal.id}
        review={selectedReview}
        previous={previousReview}
        viewerId={viewerId}
        canWrite={writable}
        onClose={() => setReviewId(null)}
      />

      <Dialog open={newItemOpen} onOpenChange={setNewItemOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a diligence item</DialogTitle>
            <DialogDescription>Give it an owner and a due date from the item once it exists.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-item-title">Item</Label>
              <Input id="new-item-title" value={newItem.title} onChange={(event) => setNewItem({ ...newItem, title: event.target.value })} placeholder="Wetlands delineation" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={newItem.category} onValueChange={(category) => setNewItem({ ...newItem, category })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DILIGENCE_CATEGORIES.map((category) => <SelectItem key={category} value={category}>{DILIGENCE_CATEGORY_LABELS[category]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-item-due">Due</Label>
                <Input id="new-item-due" type="date" value={newItem.dueOn} onChange={(event) => setNewItem({ ...newItem, dueOn: event.target.value })} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewItemOpen(false)} disabled={pending}>Cancel</Button>
            <Button
              disabled={pending || !newItem.title.trim()}
              onClick={() =>
                act(
                  "Item added",
                  async () =>
                    unwrapAction(
                      await createDiligenceItemAction(deal.id, {
                        title: newItem.title,
                        category: DILIGENCE_CATEGORIES.find((value) => value === newItem.category) ?? "other",
                        dueOn: newItem.dueOn || null,
                      }),
                    ),
                  () => setNewItemOpen(false),
                )
              }
            >
              Add item
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dropOpen} onOpenChange={setDropOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Drop {deal.name}?</DialogTitle>
            <DialogDescription>
              The deal, its diligence and every reviewed version stay on record. An open review is withdrawn.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="drop-reason">Why</Label>
            <Textarea id="drop-reason" rows={3} value={dropReason} onChange={(event) => setDropReason(event.target.value)} placeholder="Seller would not extend the feasibility period" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDropOpen(false)} disabled={pending}>Keep the deal</Button>
            <Button
              variant="destructive"
              disabled={pending || dropReason.trim().length < 10}
              onClick={() => act("Deal dropped", async () => unwrapAction(await dropLandOpportunityAction(deal.id, dropReason)), () => setDropOpen(false))}
            >
              Drop deal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
