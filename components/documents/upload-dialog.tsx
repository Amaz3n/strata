"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Upload, X, Loader2, FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { FileCategory } from "@/components/files/types"
import { useDocumentTransfers } from "./transfer-provider"
import { formatFileSize } from "./format"

interface UploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFiles?: File[]
  projectId?: string
  folderPath?: string
  onUploadComplete?: () => void
}
const CATEGORIES: FileCategory[] = ["plans", "photos", "contracts", "permits", "submittals", "rfis", "safety", "financials", "other"]

/** This sheet prepares a batch; the shell's durable queue owns its lifetime. */
export function UploadDialog({ open, onOpenChange, initialFiles, projectId, folderPath, onUploadComplete }: UploadDialogProps) {
  const transfers = useDocumentTransfers()
  const input = useRef<HTMLInputElement>(null)
  const seeded = useRef(false)
  const [items, setItems] = useState<{ id: string; file: File }[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [category, setCategory] = useState<FileCategory | "auto">("auto")
  const [visibility, setVisibility] = useState<"public" | "private">("public")
  const add = useCallback((files: File[]) => setItems(previous => [...previous, ...files.map(file => ({ id: crypto.randomUUID(), file }))]), [])
  useEffect(() => {
    if (!open) { seeded.current = false; return }
    if (!seeded.current) {
      seeded.current = true
      setItems([])
      setCategory("auto")
      setVisibility("public")
      if (initialFiles?.length) add(initialFiles)
    }
  }, [open, initialFiles, add])
  const submit = async () => {
    if (submitting || !items.length) return
    setSubmitting(true)
    const accepted = new Set<string>()
    try {
      for (const item of items) {
        const ticket = await transfers.submit(item.file, { projectId, folderPath: folderPath || "/", visibility, category: category === "auto" ? undefined : category })
        accepted.add(item.id)
        void ticket.completion.then(() => onUploadComplete?.()).catch(() => {})
      }
      toast.success(`${accepted.size} file${accepted.size === 1 ? "" : "s"} queued`)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the upload queue on this device")
    } finally {
      setItems(previous => previous.filter(item => !accepted.has(item.id)))
      setSubmitting(false)
    }
  }
  return <Sheet open={open} onOpenChange={next => { if (!submitting) onOpenChange(next) }}>
    <SheetContent className="gap-0 p-0 sm:max-w-xl" mobileFullscreen>
      <SheetHeader className="border-b px-6 py-5">
        <SheetTitle>Upload files</SheetTitle>
        <SheetDescription>Add files to {folderPath || "Project root"}. Transfers continue while you work in other pages.</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        <input ref={input} type="file" multiple className="hidden" onChange={event => { add(Array.from(event.target.files ?? [])); event.target.value = "" }} />
        <button type="button" disabled={submitting} onClick={() => input.current?.click()}
          onDragOver={event => event.preventDefault()}
          onDrop={event => { event.preventDefault(); if (!submitting) add(Array.from(event.dataTransfer.files)) }}
          className="flex min-h-36 w-full flex-col items-center justify-center gap-3 border border-dashed px-4 py-6 text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <Upload className="h-6 w-6" />Drop files here or browse
        </button>
        {items.length > 0 && <ul className="divide-y border">
          {items.map(item => <li key={item.id} className="flex items-center gap-3 px-3 py-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1"><p className="truncate text-sm">{item.file.name}</p><p className="text-xs text-muted-foreground">{formatFileSize(item.file.size)}</p></div>
            <Button size="icon" variant="ghost" disabled={submitting} aria-label={`Remove ${item.file.name}`} onClick={() => setItems(previous => previous.filter(entry => entry.id !== item.id))}><X className="h-4 w-4" /></Button>
          </li>)}
        </ul>}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2"><Label htmlFor="document-upload-category">Category</Label>
            <Select value={category} disabled={submitting} onValueChange={value => setCategory(value as FileCategory | "auto")}>
              <SelectTrigger id="document-upload-category"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Auto-detect</SelectItem>{CATEGORIES.map(value => <SelectItem key={value} value={value}>{value === "rfis" ? "RFIs" : value[0].toUpperCase() + value.slice(1)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-2"><Label htmlFor="document-upload-visibility">Visibility</Label>
            <Select value={visibility} disabled={submitting} onValueChange={value => setVisibility(value === "private" ? "private" : "public")}>
              <SelectTrigger id="document-upload-visibility"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="public">Project visible</SelectItem><SelectItem value="private">Private</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <SheetFooter className="border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs tabular-nums text-muted-foreground">{items.length} selected · {formatFileSize(items.reduce((sum, item) => sum + item.file.size, 0))}</p>
        <Button disabled={!items.length || submitting} onClick={() => { void submit() }}>{submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}Upload files</Button>
      </SheetFooter>
    </SheetContent>
  </Sheet>
}
