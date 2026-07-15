"use client"

import { useMemo, useRef, useState, useTransition } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import type { FileRecord } from "@/lib/services/files"
import type { Transmittal } from "@/lib/services/transmittals"
import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { AttachmentField } from "@/components/files"
import { uploadFileAction } from "@/app/(app)/documents/actions"
import { cn } from "@/lib/utils"
import { Plus, Search, Send, FileText, Eye, Download } from "@/components/icons"
import { createTransmittalAction, sendTransmittalAction } from "./actions"

const PURPOSE_LABELS: Record<string, string> = {
  for_review: "For review",
  for_approval: "For approval",
  for_record: "For record",
  for_construction: "For construction",
  as_requested: "As requested",
}

function parseRecipients(value: string) {
  return value.split(/\r?\n|,/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const match = line.match(/^(.*?)\s*<([^>]+)>$/)
    const email = (match?.[2] ?? line).trim()
    const displayName = (match?.[1] ?? email.split("@")[0]).trim()
    return { email, display_name: displayName }
  })
}

function viewedCount(transmittal: Transmittal) {
  return transmittal.recipients.filter((recipient) => recipient.first_viewed_at).length
}

function statusDot(transmittal: Transmittal): string {
  if (!transmittal.sent_at) return "bg-muted-foreground/40"
  const viewed = viewedCount(transmittal)
  if (viewed > 0 && viewed === transmittal.recipients.length) return "bg-success"
  return "bg-warning"
}

function StatusBadge({ transmittal }: { transmittal: Transmittal }) {
  if (!transmittal.sent_at) {
    return <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">Draft</Badge>
  }
  return <Badge variant="outline" className="text-[10px] font-normal bg-success/15 text-success border-success/30">Sent</Badge>
}

export function TransmittalsClient({ projectId, transmittals, files }: { projectId: string; transmittals: Transmittal[]; files: FileRecord[] }) {
  const router = useRouter()
  const isMobile = useIsMobile()
  const searchParams = useSearchParams()
  const drawingSheetId = searchParams.get("drawingSheet")
  const drawingDescription = searchParams.get("description") ?? "Drawing sheet"

  const [pending, startTransition] = useTransition()
  const [search, setSearch] = useState("")
  const [purposeFilter, setPurposeFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "sent">("all")
  const [createOpen, setCreateOpen] = useState(Boolean(drawingSheetId))
  const [selected, setSelected] = useState<Transmittal | null>(null)

  const submit = (work: () => Promise<void>) =>
    startTransition(() => { void work().catch((error) => toast.error(error instanceof Error ? error.message : "Something went wrong")) })

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return transmittals.filter((transmittal) => {
      if (purposeFilter !== "all" && transmittal.purpose !== purposeFilter) return false
      if (statusFilter === "draft" && transmittal.sent_at) return false
      if (statusFilter === "sent" && !transmittal.sent_at) return false
      if (term.length === 0) return true
      return [transmittal.display_number, transmittal.subject, ...transmittal.recipients.flatMap((r) => [r.email, r.display_name])].some((value) =>
        value.toLowerCase().includes(term),
      )
    })
  }, [transmittals, search, purposeFilter, statusFilter])

  const send = (transmittalId: string) =>
    submit(async () => {
      unwrapAction(await sendTransmittalAction(projectId, transmittalId))
      toast.success("Transmittal sent")
      setSelected(null)
      router.refresh()
    })

  return (
    <>
      <CreateTransmittalSheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        files={files}
        drawingSheetId={drawingSheetId}
        drawingDescription={drawingDescription}
      />
      <TransmittalDetailSheet
        transmittal={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null) }}
        pending={pending}
        onSend={send}
      />

      <div className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background">
        {isMobile ? (
          <div className="sticky top-0 z-20 shrink-0 border-b bg-background/95 backdrop-blur-sm">
            <div className="flex items-center gap-2 px-3 pt-3">
              <Input placeholder="Search transmittals..." className="h-10 text-sm" value={search} onChange={(event) => setSearch(event.target.value)} inputMode="search" />
              <Button size="icon" className="h-10 w-10 shrink-0" onClick={() => setCreateOpen(true)} aria-label="New transmittal"><Plus className="h-4 w-4" /></Button>
            </div>
            <div className="flex gap-1.5 overflow-x-auto px-3 py-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {(["all", "draft", "sent"] as const).map((key) => {
                const active = statusFilter === key
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setStatusFilter(key)}
                    className={cn(
                      "shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                      active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-muted-foreground active:bg-muted",
                    )}
                  >
                    {key === "all" ? "All" : key}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-64">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Search transmittals..." className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} />
              </div>
              <Select value={purposeFilter} onValueChange={setPurposeFilter}>
                <SelectTrigger className="w-full sm:w-44"><SelectValue placeholder="Purpose" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All purposes</SelectItem>
                  {Object.entries(PURPOSE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as "all" | "draft" | "sent")}>
                <SelectTrigger className="w-full sm:w-36"><SelectValue placeholder="Status" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={() => setCreateOpen(true)} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New transmittal
            </Button>
          </div>
        )}

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto">
            {filtered.length === 0 ? (
              <TransmittalsEmpty hasRecords={transmittals.length > 0} onNew={() => setCreateOpen(true)} />
            ) : (
              <ul className="divide-y">
                {filtered.map((transmittal) => (
                  <li key={transmittal.id} className="flex items-stretch">
                    <button type="button" onClick={() => setSelected(transmittal)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left active:bg-muted/60">
                      <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", statusDot(transmittal))} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium leading-tight">{transmittal.subject}</p>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {[transmittal.display_number, PURPOSE_LABELS[transmittal.purpose] ?? transmittal.purpose, `${transmittal.items.length} enclosure${transmittal.items.length === 1 ? "" : "s"}`].join(" · ")}
                        </p>
                      </div>
                      <StatusBadge transmittal={transmittal} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[96px]">Number</TableHead>
                  <TableHead className="min-w-[260px]">Subject</TableHead>
                  <TableHead className="hidden md:table-cell w-[150px]">Purpose</TableHead>
                  <TableHead className="hidden lg:table-cell w-[110px] text-center">Recipients</TableHead>
                  <TableHead className="hidden sm:table-cell w-[100px] text-center">Viewed</TableHead>
                  <TableHead className="hidden md:table-cell w-[110px]">Sent</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              {filtered.length ? (
                <TableBody>
                  {filtered.map((transmittal) => {
                    const viewed = viewedCount(transmittal)
                    return (
                      <TableRow key={transmittal.id} className="group h-[60px] cursor-pointer hover:bg-muted/30" onClick={() => setSelected(transmittal)}>
                        <TableCell className="font-mono text-xs text-muted-foreground">{transmittal.display_number}</TableCell>
                        <TableCell className="max-w-0">
                          <span className="block truncate text-sm font-medium">{transmittal.subject}</span>
                          <span className="block truncate text-xs text-muted-foreground">{transmittal.items.length} enclosure{transmittal.items.length === 1 ? "" : "s"}</span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">{PURPOSE_LABELS[transmittal.purpose] ?? transmittal.purpose}</TableCell>
                        <TableCell className="hidden lg:table-cell text-center text-sm tabular-nums text-muted-foreground">{transmittal.recipients.length}</TableCell>
                        <TableCell className="hidden sm:table-cell text-center">
                          <Badge variant="outline" className={cn("text-[10px] font-normal tabular-nums", viewed > 0 && viewed === transmittal.recipients.length ? "bg-success/15 text-success border-success/30" : "text-muted-foreground")}>
                            {viewed}/{transmittal.recipients.length}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{transmittal.sent_at ? new Date(transmittal.sent_at).toLocaleDateString() : "—"}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-2">
                            <span aria-hidden className={cn("h-2 w-2 shrink-0 rounded-full", statusDot(transmittal))} />
                            <StatusBadge transmittal={transmittal} />
                          </span>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              ) : null}
            </Table>
            {filtered.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <Send className="h-6 w-6 text-muted-foreground" />
                </div>
                <div className="max-w-[420px]">
                  <p className="font-medium text-foreground">{transmittals.length ? "Nothing matches your filters" : "No transmittals yet"}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {transmittals.length ? "Try a different search, purpose, or status." : "Issue drawings or documents to recipients with a tracked cover sheet."}
                  </p>
                </div>
                {transmittals.length ? null : (
                  <Button size="sm" className="mt-1" onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />New transmittal</Button>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </>
  )
}

function TransmittalsEmpty({ hasRecords, onNew }: { hasRecords: boolean; onNew: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
        <Send className="h-6 w-6 text-muted-foreground" />
      </div>
      <div>
        <p className="font-medium">{hasRecords ? "Nothing matches" : "No transmittals yet"}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{hasRecords ? "Try a different filter." : "Issue your first transmittal."}</p>
      </div>
      {hasRecords ? null : <Button className="mt-1" onClick={onNew}><Plus className="mr-2 h-4 w-4" />New transmittal</Button>}
    </div>
  )
}

const sheetContentClass = "flex flex-col p-0 shadow-2xl fast-sheet-animation sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg"
const sheetStyle = { animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties

function CreateTransmittalSheet({
  open,
  onOpenChange,
  projectId,
  files,
  drawingSheetId,
  drawingDescription,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  files: FileRecord[]
  drawingSheetId: string | null
  drawingDescription: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [purpose, setPurpose] = useState("for_review")
  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [pendingUploads, setPendingUploads] = useState<File[]>([])
  const sendNowRef = useRef(false)

  const hasEnclosures = selectedFiles.length > 0 || pendingUploads.length > 0 || Boolean(drawingSheetId)

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const sendNow = sendNowRef.current
    const element = event.currentTarget
    const form = new FormData(element)
    startTransition(() => {
      void (async () => {
        try {
          const recipients = parseRecipients(String(form.get("recipients") ?? ""))
          if (recipients.length === 0) {
            toast.error("Add at least one recipient")
            return
          }
          const uploadedItems: Array<{ file_id: string; entity_type: "file"; entity_id: string; description: string; copies: number }> = []
          for (const file of pendingUploads) {
            const upload = new FormData()
            upload.append("file", file)
            upload.append("projectId", projectId)
            upload.append("category", "other")
            upload.append("visibility", "private")
            upload.append("folderPath", "/transmittals")
            const uploaded = unwrapAction(await uploadFileAction(upload))
            uploadedItems.push({ file_id: uploaded.id, entity_type: "file", entity_id: uploaded.id, description: file.name, copies: 1 })
          }
          const items = [
            ...(drawingSheetId ? [{ entity_type: "drawing_sheet" as const, entity_id: drawingSheetId, description: drawingDescription, copies: 1 }] : []),
            ...selectedFiles.map((id) => {
              const file = files.find((candidate) => candidate.id === id)
              return { file_id: id, entity_type: "file" as const, entity_id: id, description: file?.file_name ?? "Project file", copies: 1 }
            }),
            ...uploadedItems,
          ]
          const created = unwrapAction(await createTransmittalAction({ project_id: projectId, subject: form.get("subject"), purpose, notes: form.get("notes") || null, recipients, items }))
          toast.success("Transmittal draft created")
          if (sendNow) {
            unwrapAction(await sendTransmittalAction(projectId, created.id))
            toast.success("Transmittal sent")
          }
          setSelectedFiles([])
          setPendingUploads([])
          onOpenChange(false)
          router.refresh()
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Something went wrong")
        }
      })()
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className={sheetContentClass} style={sheetStyle}>
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <div className="flex items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            <SheetTitle>New transmittal</SheetTitle>
          </div>
          <SheetDescription className="text-left">
            Sending generates the cover sheet, emails a tracked link to each recipient, and records the first view.
          </SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <div className="min-h-0 flex-1 space-y-6 overflow-auto px-6 py-4">
            <section className="space-y-4">
              <h4 className="text-sm font-medium">Details</h4>
              <div className="space-y-2">
                <Label>Subject</Label>
                <Input name="subject" defaultValue={drawingSheetId ? `Drawing issuance — ${drawingDescription}` : ""} placeholder="Transmittal subject" required minLength={2} disabled={pending} className="w-full" />
              </div>
              <div className="space-y-2">
                <Label>Purpose</Label>
                <Select value={purpose} onValueChange={setPurpose} disabled={pending}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(PURPOSE_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Notes</Label>
                <Textarea name="notes" rows={2} placeholder="Notes to recipients" disabled={pending} />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h4 className="text-sm font-medium">Recipients</h4>
              <div className="space-y-2">
                <Label>Recipients</Label>
                <Textarea name="recipients" rows={3} placeholder={"One per line\nAlex Smith <alex@example.com>"} required disabled={pending} />
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <h4 className="text-sm font-medium">Enclosures</h4>
              {drawingSheetId ? (
                <div className="flex items-center gap-2 border bg-muted/30 px-3 py-2 text-sm">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{drawingDescription}</span>
                  <span className="text-xs text-muted-foreground">drawing sheet</span>
                </div>
              ) : null}
              {files.length ? (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Select project files</Label>
                  <div className="max-h-48 overflow-auto border">
                    {files.map((file) => (
                      <label key={file.id} className="flex cursor-pointer items-center gap-3 border-b px-3 py-2 text-sm last:border-0 hover:bg-muted/40">
                        <input
                          type="checkbox"
                          checked={selectedFiles.includes(file.id)}
                          onChange={(event) => setSelectedFiles((current) => (event.target.checked ? [...current, file.id] : current.filter((id) => id !== file.id)))}
                        />
                        <span className="min-w-0 truncate">{file.file_name}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{file.category ?? "file"}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
              <AttachmentField
                projectId={projectId}
                accept="*/*"
                label="Upload new enclosures"
                emptyHint="Drag and drop or click to add files to send"
                pendingFiles={pendingUploads}
                onPendingChange={setPendingUploads}
                disabled={pending}
              />
            </section>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
            <div className="flex-1" />
            <Button type="submit" variant="outline" disabled={pending || !hasEnclosures} onClick={() => { sendNowRef.current = false }}>Create draft</Button>
            <Button type="submit" disabled={pending || !hasEnclosures} onClick={() => { sendNowRef.current = true }}>Create &amp; send</Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function TransmittalDetailSheet({
  transmittal,
  open,
  onOpenChange,
  pending,
  onSend,
}: {
  transmittal: Transmittal | null
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onSend: (transmittalId: string) => void
}) {
  if (!transmittal) return null
  const viewed = viewedCount(transmittal)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className={sheetContentClass} style={sheetStyle}>
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <Send className="h-5 w-5 text-primary" />
            <SheetTitle>{transmittal.display_number}</SheetTitle>
            {transmittal.sent_at && transmittal.pdf_file_id ? (
              <a href={`/api/files/${transmittal.pdf_file_id}/raw`} target="_blank" rel="noreferrer" className="ml-1">
                <Button variant="ghost" size="sm" type="button">PDF</Button>
              </a>
            ) : null}
            <Badge variant="outline" className="text-[10px] font-normal">{PURPOSE_LABELS[transmittal.purpose] ?? transmittal.purpose}</Badge>
            <StatusBadge transmittal={transmittal} />
          </div>
          <SheetDescription className="text-left">{transmittal.subject}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-auto px-6 py-4">
          {transmittal.notes ? (
            <section className="space-y-2">
              <h4 className="text-sm font-medium">Notes</h4>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{transmittal.notes}</p>
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Recipients</h4>
              <span className="text-xs text-muted-foreground">{viewed}/{transmittal.recipients.length} viewed</span>
            </div>
            <div className="space-y-1.5">
              {transmittal.recipients.map((recipient) => (
                <div key={recipient.id} className="flex items-center gap-3 border px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{recipient.display_name}</p>
                    <p className="truncate text-xs text-muted-foreground">{recipient.email}{recipient.company_name ? ` · ${recipient.company_name}` : ""}</p>
                  </div>
                  {recipient.first_viewed_at ? (
                    <Badge variant="outline" className="shrink-0 gap-1 text-[10px] font-normal bg-success/15 text-success border-success/30"><Eye className="h-3 w-3" />Viewed</Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0 text-[10px] font-normal text-muted-foreground">Not viewed</Badge>
                  )}
                  {recipient.first_downloaded_at ? (
                    <Badge variant="outline" className="shrink-0 gap-1 text-[10px] font-normal"><Download className="h-3 w-3" />Downloaded</Badge>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h4 className="text-sm font-medium">Enclosures</h4>
            <div className="space-y-1.5">
              {transmittal.items.map((item) => (
                <div key={item.id} className="flex items-center gap-3 border px-3 py-2 text-sm">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{item.description}</p>
                    <p className="text-xs text-muted-foreground">{(item.entity_type ?? "file").replace(/_/g, " ")}{item.copies > 1 ? ` · ${item.copies} copies` : ""}</p>
                  </div>
                  {item.file_id ? (
                    <a href={`/api/files/${item.file_id}/raw`} target="_blank" rel="noreferrer" className="shrink-0">
                      <Button variant="ghost" size="icon" className="h-7 w-7" type="button" aria-label={`View ${item.description}`}><Eye className="h-4 w-4" /></Button>
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="flex shrink-0 items-center gap-2 border-t bg-muted/30 p-4">
          <span className="text-sm text-muted-foreground">
            {transmittal.sent_at ? `Sent ${new Date(transmittal.sent_at).toLocaleDateString()}` : "Draft — not yet sent"}
          </span>
          <div className="flex-1" />
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Close</Button>
          {transmittal.sent_at ? null : (
            <Button type="button" disabled={pending} onClick={() => onSend(transmittal.id)}>
              <Send className="mr-2 h-4 w-4" />
              Send transmittal
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
