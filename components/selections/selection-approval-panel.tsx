"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  recordInPersonSelectionApprovalAction,
  sendSelectionApprovalAction,
  voidSelectionApprovalAction,
} from "@/app/(app)/design-studio/actions"
import { unwrapAction } from "@/lib/action-result"
import { uploadDocumentForm } from "@/lib/files/upload-document-form"
import {
  SELECTION_APPROVAL_CHANNEL_LABELS,
  SELECTION_APPROVAL_STATE_LABELS,
  type SelectionApprovalState,
} from "@/lib/selections/approval-state"
import type { GroupSelectionApproval } from "@/lib/services/selection-approvals"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Send, Upload } from "@/components/icons"

/** Color reports where the approval stands: approved, waiting, refused, lapsed or not yet asked. */
const STATE_TONE: Record<SelectionApprovalState, string> = {
  approved: "border-success/40 bg-success/15 text-success",
  sent: "border-primary/40 bg-primary/10 text-primary",
  declined: "border-destructive/40 bg-destructive/10 text-destructive",
  expired: "border-warning/40 bg-warning/15 text-warning",
  unsigned: "border-border bg-muted text-muted-foreground",
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function day(value: string | null) {
  if (!value) return null
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function stateLine(approval: GroupSelectionApproval): string {
  const latest = approval.latest
  if (!latest) return "Not sent to the buyer yet"
  switch (approval.state) {
    case "approved":
      return `${SELECTION_APPROVAL_CHANNEL_LABELS[latest.channel]} · ${day(latest.approvedAt) ?? ""}`
    case "sent":
      return `${SELECTION_APPROVAL_CHANNEL_LABELS[latest.channel]} · sent ${day(latest.sentAt)}${latest.expiresAt ? ` · answer by ${day(new Date(Date.parse(latest.expiresAt) - 1).toISOString())}` : ""}`
    case "declined":
      return approval.reason ? `“${approval.reason}”` : `Declined ${day(latest.sentAt)}`
    case "expired":
      return "The deadline passed without an answer"
    default:
      return approval.reason ?? "Not sent to the buyer yet"
  }
}

interface Props {
  projectId: string
  approval: GroupSelectionApproval | null
  canManage: boolean
  /** "bar" sits under a group header; "stack" fills the selection sheet's side panel. */
  layout?: "bar" | "stack"
}

/**
 * Where a group's buyer approval stands, and the one move it allows: send the
 * selections exactly as shown (e-signature or the buyer portal), record the
 * buyer's signed paper copy, or void a request that is still out.
 */
export function SelectionApprovalPanel({ projectId, approval, canManage, layout = "bar" }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [dialog, setDialog] = useState<"void" | "in_person" | null>(null)

  if (!approval) return null
  const current = approval
  const sendable = canManage && current.blocker === null
  const live = current.state === "sent" && current.latest

  function send(channel: "esign" | "portal") {
    startTransition(async () => {
      try {
        const result = unwrapAction(await sendSelectionApprovalAction({ projectId, groupId: current.groupId, channel, termsHash: current.terms.termsHash }))
        toast.success(channel === "esign" ? "Sent for e-signature" : "Sent to the buyer portal", {
          description: channel === "portal" && !result.buyerEmailed ? "The buyer has no email on file; share the portal link with them." : undefined,
        })
        router.refresh()
      } catch (error) {
        toast.error("Could not send the selections", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function voidRequest(formData: FormData) {
    if (!current.latest) return
    const approvalId = current.latest.id
    startTransition(async () => {
      try {
        unwrapAction(await voidSelectionApprovalAction({ projectId, approvalId, reason: String(formData.get("reason") ?? "") }))
        setDialog(null)
        toast.success("Request voided")
        router.refresh()
      } catch (error) {
        toast.error("Could not void the request", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function recordInPerson(formData: FormData) {
    const file = formData.get("file")
    if (!(file instanceof File) || file.size === 0) {
      toast.error("Attach the buyer's signed copy")
      return
    }
    startTransition(async () => {
      try {
        const upload = new FormData()
        upload.set("file", file)
        upload.set("projectId", projectId)
        upload.set("category", "contracts")
        upload.set("visibility", "private")
        const signed = unwrapAction(await uploadDocumentForm(upload))
        unwrapAction(await recordInPersonSelectionApprovalAction({ projectId, groupId: current.groupId, termsHash: current.terms.termsHash, signedCopyFileId: signed.id }))
        setDialog(null)
        toast.success(`${current.groupName} approved`)
        router.refresh()
      } catch (error) {
        toast.error("Could not record the approval", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const stacked = layout === "stack"

  return (
    <div className={stacked ? "flex flex-col gap-2" : "flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2"}>
      <div className={stacked ? "flex flex-col gap-1" : "flex min-w-0 items-center gap-2"}>
        <span className="flex items-center gap-2">
          <Badge variant="outline" className={`rounded-full px-2 text-[11px] ${STATE_TONE[current.state]}`}>
            {SELECTION_APPROVAL_STATE_LABELS[current.state]}
          </Badge>
          <span className="font-mono tabular-nums text-[12px]">{money(current.terms.totalCents)}</span>
        </span>
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground" title={stateLine(current)}>
          {stateLine(current)}
        </span>
      </div>
      {canManage && (
        <div className={stacked ? "flex flex-col gap-1.5" : "flex flex-wrap items-center gap-1.5"}>
          {live ? (
            <Button size="sm" variant="outline" className="h-7 rounded-none" disabled={pending} onClick={() => setDialog("void")}>
              Void request
            </Button>
          ) : current.blocker && current.state !== "approved" ? (
            <span className="text-[11.5px] text-muted-foreground">{current.blocker}</span>
          ) : current.state === "approved" ? null : (
            <>
              <Button size="sm" className="h-7 rounded-none" disabled={pending || !sendable} onClick={() => send("esign")}>
                <Send className="mr-1.5 h-3.5 w-3.5" />
                Send for e-signature
              </Button>
              <Button size="sm" variant="outline" className="h-7 rounded-none" disabled={pending || !sendable} onClick={() => send("portal")}>
                Send to buyer portal
              </Button>
              <Button size="sm" variant="ghost" className="h-7 rounded-none" disabled={pending || !sendable} onClick={() => setDialog("in_person")}>
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Record signed copy
              </Button>
            </>
          )}
        </div>
      )}

      <Dialog open={dialog === "void"} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <DialogContent className="rounded-none">
          <form action={voidRequest}>
            <DialogHeader>
              <DialogTitle>Void the {current.groupName.toLowerCase()} request</DialogTitle>
              <DialogDescription>
                The buyer can no longer approve it{current.latest?.channel === "esign" ? " and the signing link stops working" : ""}. Send the selections again when they are ready.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 py-4">
              <Label htmlFor="void-reason">Reason</Label>
              <Textarea id="void-reason" name="reason" required minLength={3} maxLength={500} className="rounded-none" />
            </div>
            <DialogFooter>
              <Button type="submit" variant="destructive" disabled={pending} className="rounded-none">Void request</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "in_person"} onOpenChange={(open) => { if (!open) setDialog(null) }}>
        <DialogContent className="rounded-none">
          <form action={recordInPerson}>
            <DialogHeader>
              <DialogTitle>Record the buyer&apos;s signed copy</DialogTitle>
              <DialogDescription>
                Approves the {current.groupName.toLowerCase()} selections at {money(current.terms.totalCents)}, exactly as shown, with the signed page filed on the home.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5 py-4">
              <Label htmlFor="signed-copy">Signed copy</Label>
              <Input id="signed-copy" name="file" type="file" accept="application/pdf,image/*" required className="rounded-none" />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending} className="rounded-none">Record approval</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
