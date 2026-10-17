"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { acceptAgreementWithoutExecutedCopyAction, attachExecutedAgreementAction } from "@/app/(app)/settings/imports/actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { parseAgreementSigners } from "@/lib/cutover/records"

interface Props {
  evidenceId: string
  projectId: string
  home: string
  signedOn: string | null
  files: Array<{ id: string; name: string }>
}

/** One imported agreement's review: attach its executed copy from the home's documents, or accept it without one and say why. */
export function AgreementEvidenceReview({ evidenceId, projectId, home, signedOn, files }: Props) {
  const router = useRouter()
  const [mode, setMode] = useState<"attach" | "accept" | null>(null)
  const [fileId, setFileId] = useState(files[0]?.id ?? "")
  const [signers, setSigners] = useState("")
  const [date, setDate] = useState(signedOn ?? "")
  const [reason, setReason] = useState("")
  const [pending, startTransition] = useTransition()
  const parsedSigners = parseAgreementSigners(signers)
  const canAttach = Boolean(fileId) && Boolean(date) && parsedSigners !== null && parsedSigners.length > 0
  const canAccept = reason.trim().length >= 10

  const submit = () => startTransition(async () => {
    const result = mode === "attach"
      ? await attachExecutedAgreementAction({ evidenceId, fileId, signers: parsedSigners ?? [], signedOn: date })
      : await acceptAgreementWithoutExecutedCopyAction({ evidenceId, reason })
    if (!result.success) { toast.error(result.error); return }
    toast.success(mode === "attach" ? "Executed copy attached" : "Agreement accepted without its executed copy")
    setMode(null)
    router.refresh()
  })

  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" onClick={() => setMode("attach")}>Attach executed copy</Button>
      <Button size="sm" variant="ghost" onClick={() => setMode("accept")}>Accept without file</Button>
      <Dialog open={mode !== null} onOpenChange={(open) => { if (!open) setMode(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === "attach" ? "Attach the executed copy" : "Accept without an executed copy"}</DialogTitle>
            <DialogDescription>
              {mode === "attach"
                ? `${home}: the copy is bound by its SHA-256 and cannot be changed afterwards.`
                : `${home}: closing can proceed on your acceptance, which is recorded with your name and reason and cannot be changed afterwards.`}
            </DialogDescription>
          </DialogHeader>
          {mode === "attach" ? (
            <div className="space-y-4">
              {files.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No PDF is on file for this home. Upload the executed agreement to the home&apos;s{" "}
                  <Link className="text-foreground underline" href={`/projects/${projectId}/documents`}>documents</Link> first.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <Label>Executed file</Label>
                  <Select value={fileId} onValueChange={setFileId}>
                    <SelectTrigger><SelectValue placeholder="Choose the file" /></SelectTrigger>
                    <SelectContent>{files.map((file) => <SelectItem key={file.id} value={file.id}>{file.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`signers-${evidenceId}`}>Signers</Label>
                <Input id={`signers-${evidenceId}`} value={signers} onChange={(event) => setSigners(event.target.value)} placeholder="Rosa Quintero <rosa@example.com>; Builder <sales@example.com>" />
                {parsedSigners === null ? <p className="text-xs text-destructive">Write each signer as Name &lt;email&gt;, separated by semicolons.</p> : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`signed-${evidenceId}`}>Signed on</Label>
                <Input id={`signed-${evidenceId}`} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor={`reason-${evidenceId}`}>Reason</Label>
              <Textarea id={`reason-${evidenceId}`} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this agreement stands without its executed copy" />
              <p className="text-xs text-muted-foreground">At least 10 characters.</p>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMode(null)} disabled={pending}>Cancel</Button>
            <Button onClick={submit} disabled={pending || (mode === "attach" ? !canAttach : !canAccept)}>{mode === "attach" ? "Attach" : "Accept"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
