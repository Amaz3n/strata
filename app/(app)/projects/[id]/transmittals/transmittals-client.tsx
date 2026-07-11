"use client"

import { useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { FileRecord } from "@/lib/services/files"
import type { Transmittal } from "@/lib/services/transmittals"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { createTransmittalAction, sendTransmittalAction } from "./actions"

function parseRecipients(value: string) {
  return value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(.*?)\s*<([^>]+)>$/)
    const email = (match?.[2] ?? line).trim()
    const displayName = (match?.[1] ?? email.split("@")[0]).trim()
    return { email, display_name: displayName }
  })
}

export function TransmittalsClient({ projectId, transmittals, files }: { projectId: string; transmittals: Transmittal[]; files: FileRecord[] }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const drawingSheetId = searchParams.get("drawingSheet")
  const drawingDescription = searchParams.get("description") ?? "Drawing sheet"
  const [pending, startTransition] = useTransition()
  const [purpose, setPurpose] = useState("for_review")
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const submit = (work: () => Promise<void>) => startTransition(() => { void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong")) })
  return <div className="space-y-6">
    <form className="grid gap-4 border p-4 lg:grid-cols-[1fr_240px]" onSubmit={(event) => {
      event.preventDefault()
      const element = event.currentTarget
      const form = new FormData(element)
      submit(async () => {
        const recipients = parseRecipients(String(form.get("recipients") ?? ""))
        const items = [
          ...(drawingSheetId ? [{ entity_type: "drawing_sheet" as const, entity_id: drawingSheetId, description: drawingDescription, copies: 1 }] : []),
          ...selectedFiles.map((id) => { const file = files.find((candidate) => candidate.id === id); return { file_id: id, entity_type: "file" as const, entity_id: id, description: file?.file_name ?? "Project file", copies: 1 } }),
        ]
        const created = unwrapAction(await createTransmittalAction({ project_id: projectId, subject: form.get("subject"), purpose, notes: form.get("notes") || null, recipients, items }))
        toast.success("Transmittal draft created")
        element.reset(); setSelectedFiles([]); router.refresh()
        if (form.get("send_now") === "yes") { unwrapAction(await sendTransmittalAction(projectId, created.id)); toast.success("Transmittal sent"); router.refresh() }
      })
    }}>
      <div className="space-y-3"><Input name="subject" defaultValue={drawingSheetId ? `Drawing issuance — ${drawingDescription}` : ""} placeholder="Transmittal subject" required minLength={2} disabled={pending} /><Textarea name="notes" placeholder="Notes to recipients" disabled={pending} /><Textarea name="recipients" placeholder={'Recipients — one per line\nAlex Smith <alex@example.com>'} required disabled={pending} /><div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Select enclosures</div><div className="max-h-48 overflow-auto border">{drawingSheetId ? <div className="border-b px-3 py-2 text-sm"><span className="font-medium">{drawingDescription}</span><span className="ml-2 text-xs text-muted-foreground">drawing sheet</span></div> : null}{files.length ? files.map((file) => <label key={file.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-0"><input type="checkbox" checked={selectedFiles.includes(file.id)} onChange={(e) => setSelectedFiles((current) => e.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id))} /><span className="min-w-0 truncate">{file.file_name}</span><span className="ml-auto text-xs text-muted-foreground">{file.category ?? "file"}</span></label>) : !drawingSheetId ? <p className="p-4 text-sm text-muted-foreground">Upload project files before creating a transmittal.</p> : null}</div></div></div>
      <div className="space-y-3"><Select value={purpose} onValueChange={setPurpose} disabled={pending}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="for_review">For review</SelectItem><SelectItem value="for_approval">For approval</SelectItem><SelectItem value="for_record">For record</SelectItem><SelectItem value="for_construction">For construction</SelectItem><SelectItem value="as_requested">As requested</SelectItem></SelectContent></Select><Button type="submit" className="w-full" disabled={pending || (!selectedFiles.length && !drawingSheetId)}>Create draft</Button><Button type="submit" name="send_now" value="yes" variant="secondary" className="w-full" disabled={pending || (!selectedFiles.length && !drawingSheetId)}>Create & send</Button><p className="text-xs leading-relaxed text-muted-foreground">Sending generates the cover sheet, emails a tracked link to each recipient, and records the first view.</p></div>
    </form>
    <div className="border"><Table><TableHeader><TableRow><TableHead className="w-28">Number</TableHead><TableHead>Subject</TableHead><TableHead className="w-36">Purpose</TableHead><TableHead className="w-28">Recipients</TableHead><TableHead className="w-28">Viewed</TableHead><TableHead className="w-32">Sent</TableHead><TableHead className="w-24" /></TableRow></TableHeader><TableBody>{transmittals.length ? transmittals.map((item) => { const viewed = item.recipients.filter((recipient) => recipient.first_viewed_at).length; return <TableRow key={item.id}><TableCell className="font-mono text-xs">{item.display_number}</TableCell><TableCell><div className="font-medium">{item.subject}</div><div className="text-xs text-muted-foreground">{item.items.length} enclosure{item.items.length === 1 ? "" : "s"}</div></TableCell><TableCell className="capitalize">{item.purpose.replaceAll("_", " ")}</TableCell><TableCell>{item.recipients.length}</TableCell><TableCell><Badge variant={viewed === item.recipients.length && viewed > 0 ? "secondary" : "outline"}>{viewed}/{item.recipients.length}</Badge></TableCell><TableCell>{item.sent_at ? new Date(item.sent_at).toLocaleDateString() : "Draft"}</TableCell><TableCell>{item.sent_at ? item.pdf_file_id ? <Button size="sm" variant="ghost" asChild><a href={`/api/files/${item.pdf_file_id}/raw`}>PDF</a></Button> : null : <Button size="sm" variant="outline" disabled={pending} onClick={() => submit(async () => { unwrapAction(await sendTransmittalAction(projectId, item.id)); toast.success("Transmittal sent"); router.refresh() })}>Send</Button>}</TableCell></TableRow> }) : <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No transmittals yet.</TableCell></TableRow>}</TableBody></Table></div>
  </div>
}
