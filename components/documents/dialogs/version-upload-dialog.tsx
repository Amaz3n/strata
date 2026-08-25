"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { FileCheck2, History, Loader2, UploadCloud } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { FileWithUrls } from "@/app/(app)/documents/types"
import { formatDate, formatFileSize } from "../format"
import type { FileVersionInfo } from "./file-versions"

interface VersionUploadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The document receiving the new version. Null while the dialog is closed. */
  file: FileWithUrls | null
  /** Version history for `file`, owned by the layout so the viewer shares it. */
  versions: FileVersionInfo[]
  /** Refetches history into the layout's version store. */
  onLoadVersions: (fileId: string) => Promise<void>
  onUploadVersion: (
    fileId: string,
    file: File,
    label?: string,
    notes?: string,
  ) => Promise<void>
}

export function VersionUploadDialog({
  open,
  onOpenChange,
  file,
  versions,
  onLoadVersions,
  onUploadVersion,
}: VersionUploadDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [label, setLabel] = useState("")
  const [notes, setNotes] = useState("")
  const [isUploading, setIsUploading] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)

  useEffect(() => {
    if (!open || !file) return

    setUploadFile(null)
    setLabel("")
    setNotes("")
    setIsUploading(false)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }

    let cancelled = false
    setIsLoadingHistory(true)
    onLoadVersions(file.id)
      .catch((error) => {
        console.error("Failed to load version history:", error)
      })
      .finally(() => {
        if (!cancelled) setIsLoadingHistory(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, file, onLoadVersions])

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const selected = event.target.files?.[0] ?? null
      if (selected) {
        setUploadFile(selected)
      }
    },
    [],
  )

  const handleConfirm = useCallback(async () => {
    if (!file || !uploadFile) {
      toast.error("Choose a file for the new version")
      return
    }

    setIsUploading(true)
    try {
      await onUploadVersion(
        file.id,
        uploadFile,
        label.trim() || undefined,
        notes.trim() || undefined,
      )
      toast.success("New version uploaded")
      onOpenChange(false)
    } catch (error) {
      console.error("Failed to upload version:", error)
      toast.error("Failed to upload new version")
    } finally {
      setIsUploading(false)
    }
  }, [file, uploadFile, label, notes, onUploadVersion, onOpenChange])

  const recentVersions = versions.slice(0, 4)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Upload new version</DialogTitle>
          <DialogDescription>
            Add a revised file while keeping the same document record, sharing, and history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {file ? (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-background text-primary shadow-sm">
                  <FileCheck2 className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Current file</p>
                  <p className="truncate text-sm font-semibold">{file.file_name}</p>
                  <p className="text-xs text-muted-foreground">
                    Latest v{file.version_number ?? 1} · {formatFileSize(file.size_bytes)}
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
            disabled={isUploading}
          />

          <Button
            type="button"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className={cn(
              "h-auto w-full justify-start rounded-lg border-dashed px-4 py-4 text-left transition-colors",
              uploadFile ? "border-primary/40 bg-primary/5" : "hover:bg-muted/40",
            )}
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <UploadCloud className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium">
                  {uploadFile ? "Replacement file selected" : "Choose the revised file"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {uploadFile
                    ? `${uploadFile.name} · ${formatFileSize(uploadFile.size)}`
                    : "This becomes the latest version after you click Upload version."}
                </p>
              </div>
            </div>
          </Button>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div className="space-y-2">
              <Label htmlFor="version-label">Version label</Label>
              <Input
                id="version-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Addendum 2, final, owner comments"
                disabled={isUploading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="version-notes">Notes</Label>
              <Input
                id="version-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Short note about what changed"
                disabled={isUploading}
              />
            </div>
          </div>

          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <div className="flex items-center gap-2">
                <History className="h-4 w-4 text-muted-foreground" />
                <p className="text-sm font-medium">Recent versions</p>
              </div>
              {versions.length > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {versions.length} total
                </span>
              ) : null}
            </div>
            {isLoadingHistory ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading history...
              </div>
            ) : recentVersions.length > 0 ? (
              <div className="divide-y">
                {recentVersions.map((version) => (
                  <div key={version.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                      v{version.version_number}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {version.label || version.file_name || `Version ${version.version_number}`}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {version.creator_name ?? "Unknown"} · {formatDate(version.created_at)}
                        {version.size_bytes ? ` · ${formatFileSize(version.size_bytes)}` : ""}
                      </p>
                    </div>
                    {version.is_current ? (
                      <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                        Current
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                No version history yet. This upload will create the next version.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isUploading}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isUploading || !uploadFile}>
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Uploading...
              </>
            ) : (
              "Upload version"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
