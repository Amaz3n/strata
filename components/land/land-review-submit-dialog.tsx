"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition, type ReactNode } from "react"
import { toast } from "sonner"

import { submitAcquisitionReviewAction } from "@/app/(app)/communities/land-deals/actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { AcquisitionDecision } from "@/lib/land/diligence"
import type { LandPersonOption } from "@/lib/services/land-opportunities"

const MAX_APPROVERS = 5

/**
 * Freeze the deal as it stands and name who decides it. Approvers decide in
 * parallel; every one must approve, any one can return it, and the submitter
 * can never be one of them.
 */
export function SubmitReviewDialog({
  dealId,
  people,
  viewerId,
  openIssues,
  trigger,
}: {
  dealId: string
  people: LandPersonOption[]
  viewerId: string
  /** Open or issue items, said out loud before a version is frozen with them. */
  openIssues: number
  trigger: ReactNode
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [decision, setDecision] = useState<AcquisitionDecision>("acquire")
  const [summary, setSummary] = useState("")
  const [approvers, setApprovers] = useState<Array<{ userId: string; label: string }>>([])
  const [pending, startTransition] = useTransition()
  const eligible = people.filter((person) => person.canApprove && person.id !== viewerId)

  function toggle(userId: string, checked: boolean) {
    setApprovers((current) =>
      checked ? [...current, { userId, label: "" }].slice(0, MAX_APPROVERS) : current.filter((entry) => entry.userId !== userId),
    )
  }

  function submit() {
    startTransition(async () => {
      try {
        unwrapAction(
          await submitAcquisitionReviewAction(dealId, {
            decision,
            summary: summary || null,
            approvers: approvers.map((entry) => ({ userId: entry.userId, label: entry.label || null })),
          }),
        )
        toast.success("Submitted for review")
        setOpen(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to submit", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDecision("acquire")
          setSummary("")
          setApprovers([])
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit for acquisition review</DialogTitle>
          <DialogDescription>
            The terms, checklist and filed documents are frozen into this version. Changing any of them before every approver decides supersedes it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {openIssues > 0 ? (
            <p className="border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              {openIssues} diligence item{openIssues === 1 ? " is" : "s are"} still open or flagged. Approvers will see them as they stand.
            </p>
          ) : null}
          <div className="space-y-1.5">
            <Label>Decision</Label>
            <Select value={decision} onValueChange={(value) => setDecision(value === "terminate" ? "terminate" : "acquire")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="acquire">Acquire the land</SelectItem>
                <SelectItem value="terminate">Terminate the contract</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="review-summary">Recommendation</Label>
            <Textarea id="review-summary" rows={3} value={summary} onChange={(event) => setSummary(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Approvers ({approvers.length}/{MAX_APPROVERS})</Label>
            {eligible.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nobody else holds land approval. An admin can grant it in Settings → Team.</p>
            ) : (
              <ul className="max-h-64 divide-y overflow-y-auto border">
                {eligible.map((person) => {
                  const chosen = approvers.find((entry) => entry.userId === person.id)
                  return (
                    <li key={person.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <Checkbox
                        id={`approver-${person.id}`}
                        checked={Boolean(chosen)}
                        disabled={!chosen && approvers.length >= MAX_APPROVERS}
                        onCheckedChange={(checked) => toggle(person.id, checked === true)}
                      />
                      <Label htmlFor={`approver-${person.id}`} className="flex-1 font-normal">{person.name}</Label>
                      {chosen ? (
                        <Input
                          value={chosen.label}
                          onChange={(event) =>
                            setApprovers((current) =>
                              current.map((entry) => (entry.userId === person.id ? { ...entry, label: event.target.value } : entry)),
                            )
                          }
                          placeholder="Role, e.g. CFO"
                          className="h-7 w-36 text-xs"
                          aria-label={`${person.name}'s role on this review`}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
          <Button onClick={submit} disabled={pending || approvers.length === 0}>{pending ? "Submitting…" : "Submit version"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
