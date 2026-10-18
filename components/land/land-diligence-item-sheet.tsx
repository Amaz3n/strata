"use client"

import { useRouter } from "next/navigation"
import { useEffect, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  attachDiligenceEvidenceAction,
  deleteDiligenceItemAction,
  removeDiligenceEvidenceAction,
  reopenDiligenceItemAction,
  resolveDiligenceItemAction,
  updateDiligenceItemAction,
} from "@/app/(app)/communities/land-deals/actions"
import { Download, Paperclip, Trash2, Upload } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import {
  DILIGENCE_CATEGORIES,
  DILIGENCE_CATEGORY_LABELS,
  DILIGENCE_STATUS_LABELS,
  type DiligenceCategory,
  type DiligenceStatus,
} from "@/lib/land/diligence"
import type { DiligenceItemDTO, LandCompanyOption, LandPersonOption } from "@/lib/services/land-opportunities"
import { cn } from "@/lib/utils"

import { shortDate } from "./land-format"

const NONE = "none"

export const DILIGENCE_STATUS_TONE: Record<DiligenceStatus, string> = {
  open: "border-border bg-muted text-muted-foreground",
  satisfied: "border-success/40 bg-success/10 text-success",
  issue: "border-destructive/40 bg-destructive/10 text-destructive",
  waived: "border-warning/40 bg-warning/10 text-warning",
}

export function DiligenceStatusBadge({ status }: { status: DiligenceStatus }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium uppercase tracking-wide", DILIGENCE_STATUS_TONE[status])}>
      {DILIGENCE_STATUS_LABELS[status]}
    </Badge>
  )
}

function isCategory(value: string): value is DiligenceCategory {
  return DILIGENCE_CATEGORIES.some((category) => category === value)
}

/**
 * One diligence item: who owns it, when it is due, what was found, and the
 * documents that prove it. Resolving is a decision with a record -- a finding,
 * a filed document, or a waiver reason.
 */
export function DiligenceItemSheet({
  dealId,
  item,
  people,
  companies,
  canWrite,
  onClose,
}: {
  dealId: string
  item: DiligenceItemDTO | null
  people: LandPersonOption[]
  companies: LandCompanyOption[]
  canWrite: boolean
  onClose: () => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const fileInput = useRef<HTMLInputElement>(null)
  const [details, setDetails] = useState({ title: "", category: "other", ownerUserId: NONE, ownerCompanyId: NONE, dueOn: "" })
  const [finding, setFinding] = useState("")
  const [waiverReason, setWaiverReason] = useState("")

  useEffect(() => {
    if (!item) return
    setDetails({
      title: item.title,
      category: item.category,
      ownerUserId: item.ownerUserId ?? NONE,
      ownerCompanyId: item.ownerCompanyId ?? NONE,
      dueOn: item.dueOn ?? "",
    })
    setFinding(item.finding ?? "")
    setWaiverReason(item.waivedReason ?? "")
  }, [item])

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

  const editable = canWrite && item !== null
  const open = item?.status === "open"

  return (
    <Sheet open={item !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {item ? (
          <>
            <SheetHeader className="border-b pb-3">
              <div className="flex items-center gap-2">
                <DiligenceStatusBadge status={item.status} />
                <span className="microlabel">{isCategory(item.category) ? DILIGENCE_CATEGORY_LABELS[item.category] : item.category}</span>
              </div>
              <SheetTitle className="text-base">{item.title}</SheetTitle>
              <SheetDescription>
                {item.resolvedAt ? `Resolved ${shortDate(item.resolvedAt)}` : item.dueOn ? `Due ${shortDate(item.dueOn)}` : "No due date"}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-4 pb-6">
              <section className="space-y-3">
                <h3 className="microlabel">Ownership</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="item-title">Item</Label>
                    <Input id="item-title" disabled={!editable} value={details.title} onChange={(event) => setDetails({ ...details, title: event.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Category</Label>
                    <Select disabled={!editable} value={details.category} onValueChange={(category) => setDetails({ ...details, category })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {DILIGENCE_CATEGORIES.map((category) => <SelectItem key={category} value={category}>{DILIGENCE_CATEGORY_LABELS[category]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="item-due">Due</Label>
                    <Input id="item-due" type="date" disabled={!editable} value={details.dueOn} onChange={(event) => setDetails({ ...details, dueOn: event.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Owner</Label>
                    <Select disabled={!editable} value={details.ownerUserId} onValueChange={(ownerUserId) => setDetails({ ...details, ownerUserId })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Unassigned</SelectItem>
                        {people.map((person) => <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Consultant</Label>
                    <Select disabled={!editable} value={details.ownerCompanyId} onValueChange={(ownerCompanyId) => setDetails({ ...details, ownerCompanyId })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None</SelectItem>
                        {companies.map((company) => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {editable ? (
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending || !details.title.trim()}
                      onClick={() =>
                        act("Item saved", async () =>
                          unwrapAction(
                            await updateDiligenceItemAction(dealId, item.id, {
                              title: details.title,
                              category: isCategory(details.category) ? details.category : "other",
                              ownerUserId: details.ownerUserId === NONE ? null : details.ownerUserId,
                              ownerCompanyId: details.ownerCompanyId === NONE ? null : details.ownerCompanyId,
                              dueOn: details.dueOn || null,
                            }),
                          ),
                        )
                      }
                    >
                      Save
                    </Button>
                  </div>
                ) : null}
              </section>

              <section className="space-y-3">
                <h3 className="microlabel">Evidence</h3>
                {item.evidence.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No documents filed. A satisfied item stands on a document or a written finding.</p>
                ) : (
                  <ul className="divide-y border">
                    {item.evidence.map((entry) => (
                      <li key={entry.linkId} className="flex items-center gap-2 px-3 py-2 text-xs">
                        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{entry.fileName}</span>
                        <span className="tabular-nums text-muted-foreground">{shortDate(entry.uploadedAt)}</span>
                        <Button asChild variant="ghost" size="sm" className="h-7 w-7 p-0">
                          <a href={entry.url} target="_blank" rel="noreferrer"><Download className="h-3.5 w-3.5" /><span className="sr-only">Open {entry.fileName}</span></a>
                        </Button>
                        {editable ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            disabled={pending}
                            onClick={() => act("Evidence unfiled", async () => unwrapAction(await removeDiligenceEvidenceAction(dealId, item.id, entry.linkId)))}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="sr-only">Unfile {entry.fileName}</span>
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                {editable ? (
                  <>
                    <input
                      ref={fileInput}
                      type="file"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ""
                        if (!file) return
                        const form = new FormData()
                        form.set("file", file)
                        act("Evidence filed", async () => unwrapAction(await attachDiligenceEvidenceAction(dealId, item.id, form)))
                      }}
                    />
                    <Button size="sm" variant="outline" disabled={pending} onClick={() => fileInput.current?.click()}>
                      <Upload className="mr-1.5 h-3.5 w-3.5" />Attach document
                    </Button>
                  </>
                ) : null}
              </section>

              <section className="space-y-3">
                <h3 className="microlabel">Finding</h3>
                <Textarea
                  rows={4}
                  disabled={!editable || !open}
                  value={finding}
                  onChange={(event) => setFinding(event.target.value)}
                  placeholder="What the report, survey or search found"
                />
                {item.status === "waived" && item.waivedReason ? (
                  <p className="text-xs text-muted-foreground">Waived: {item.waivedReason}</p>
                ) : null}
                {editable && open ? (
                  <div className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => act("Marked satisfied", async () => unwrapAction(await resolveDiligenceItemAction(dealId, item.id, { status: "satisfied", finding: finding || null })))}
                      >
                        Mark satisfied
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || !finding.trim()}
                        onClick={() => act("Issue recorded", async () => unwrapAction(await resolveDiligenceItemAction(dealId, item.id, { status: "issue", finding })))}
                      >
                        Record issue
                      </Button>
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="flex-1 space-y-1.5">
                        <Label htmlFor="item-waiver">Waive with a reason</Label>
                        <Input id="item-waiver" value={waiverReason} onChange={(event) => setWaiverReason(event.target.value)} placeholder="Why the risk is accepted" />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || waiverReason.trim().length < 10}
                        onClick={() => act("Item waived", async () => unwrapAction(await resolveDiligenceItemAction(dealId, item.id, { status: "waived", waivedReason: waiverReason, finding: finding || null })))}
                      >
                        Waive
                      </Button>
                    </div>
                  </div>
                ) : null}
                {editable && !open ? (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => act("Item reopened", async () => unwrapAction(await reopenDiligenceItemAction(dealId, item.id)))}>
                    Reopen
                  </Button>
                ) : null}
              </section>

              {editable && open && item.evidence.length === 0 ? (
                <div className="border-t pt-4">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={pending}
                    onClick={() => act("Item removed", async () => unwrapAction(await deleteDiligenceItemAction(dealId, item.id)), onClose)}
                  >
                    Remove item
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
