"use client"
import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { withdrawSignedEstimateForRevisionAction } from "@/app/(app)/estimates/actions"
import { unwrapAction } from "@/lib/action-result"
import { toast } from "sonner"

export function EstimateWithdrawDialog({ estimateId, open, onOpenChange, onWithdrawn }: { estimateId: string; open: boolean; onOpenChange: (open: boolean) => void; onWithdrawn: (estimate: any) => void }) {
  const [reason, setReason] = useState("")
  const [pending, setPending] = useState(false)
  async function withdraw() {
    setPending(true)
    try {
      const revised = unwrapAction(await withdrawSignedEstimateForRevisionAction(estimateId, reason))
      toast.success("Pending agreement withdrawn; new draft created")
      onWithdrawn(revised)
      onOpenChange(false)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to withdraw agreement") }
    finally { setPending(false) }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent><DialogHeader><DialogTitle>Withdraw pending agreement</DialogTitle><DialogDescription>This cancels builder signing and preserves the client-signed version in history. Review the new draft and send it for fresh client approval.</DialogDescription></DialogHeader><Label htmlFor="estimate-withdraw-reason">Reason for withdrawal</Label><Textarea id="estimate-withdraw-reason" value={reason} onChange={(e) => setReason(e.target.value)} /><DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button><Button disabled={pending || reason.trim().length < 5} onClick={withdraw}>{pending ? "Withdrawing…" : "Withdraw and create revision"}</Button></DialogFooter></DialogContent></Dialog>
}
