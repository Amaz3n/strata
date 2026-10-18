"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { executeProjectCommitmentAction } from "@/app/(app)/projects/[id]/commitments/actions"
import { uploadDocumentForm as uploadFileAction } from "@/lib/files/upload-document-form"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"

const todayIso = () => new Date().toISOString().slice(0, 10)

/**
 * Records an agreement signed outside Arc — on paper, or countersigned and
 * returned by email. The signed document is required: it is the record of
 * execution kept with the commitment.
 */
export function RecordExecutionDialog({
  open,
  onOpenChange,
  projectId,
  commitmentId,
  onRecorded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  commitmentId: string
  onRecorded: () => void | Promise<void>
}) {
  const [file, setFile] = useState<File | null>(null)
  const [executedAt, setExecutedAt] = useState(todayIso)
  const [note, setNote] = useState("")
  const [isPending, startTransition] = useTransition()

  function reset() {
    setFile(null)
    setExecutedAt(todayIso())
    setNote("")
  }

  function record() {
    if (!file) return
    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", projectId)
        formData.append("category", "contracts")
        const uploaded = unwrapAction(await uploadFileAction(formData))
        unwrapAction(
          await executeProjectCommitmentAction(projectId, commitmentId, {
            executed_file_id: uploaded.id,
            executed_at: executedAt,
            note: note.trim() || undefined,
          }),
        )
        toast.success("Execution recorded")
        reset()
        onOpenChange(false)
        await onRecorded()
      } catch (error) {
        toast.error("Unable to record execution", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record signed agreement</DialogTitle>
          <DialogDescription>
            For an agreement signed outside Arc — on paper, or countersigned and returned by email. The signed
            document is kept with the commitment as the record of execution.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="executed-agreement">Signed agreement</Label>
            <input
              id="executed-agreement"
              type="file"
              accept="application/pdf,image/*"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="block w-full border bg-background px-2 py-1.5 text-sm file:mr-3 file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="executed-date">Date signed</Label>
            <Input
              id="executed-date"
              type="date"
              max={todayIso()}
              value={executedAt}
              onChange={(event) => setExecutedAt(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="executed-note">Note</Label>
            <Textarea
              id="executed-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Where the original is held, who signed, or anything worth knowing later."
              rows={2}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={record} disabled={isPending || !file}>
              {isPending ? "Recording…" : "Record execution"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
