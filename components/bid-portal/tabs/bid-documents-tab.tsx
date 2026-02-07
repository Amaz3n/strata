"use client"

import { format } from "date-fns"
import { Download, FileText, File } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import type { FileMetadata } from "@/lib/types"

interface BidDocumentsTabProps {
  files: FileMetadata[]
}

function formatFileSize(bytes?: number) {
  if (!bytes) return "—"
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getFileIcon(mimeType?: string) {
  if (mimeType?.includes("pdf")) return FileText
  return File
}

export function BidDocumentsTab({ files }: BidDocumentsTabProps) {
  if (files.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <FileText className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
          <p className="text-sm text-muted-foreground">No files attached to this bid package yet.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Package Files</CardTitle>
          <p className="text-sm text-muted-foreground">
            Download these files to review the project requirements
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {files.map((file) => {
            const FileIcon = getFileIcon(file.mime_type)
            return (
              <div
                key={file.id}
                className="flex items-center justify-between gap-3 rounded-lg border p-3 bg-muted/30"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 shrink-0">
                    <FileIcon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{file.file_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(file.size_bytes)} • {format(new Date(file.created_at), "MMM d, yyyy")}
                    </p>
                  </div>
                </div>
                {file.url && (
                  <Button variant="outline" size="sm" asChild className="shrink-0">
                    <a href={file.url} target="_blank" rel="noopener noreferrer">
                      <Download className="h-4 w-4 mr-2" />
                      Download
                    </a>
                  </Button>
                )}
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
