"use client"

import React from "react"
import { format } from "date-fns"
import { Download, FileText, File, FolderOpen } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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

interface FolderNode {
  id: string
  name: string
  path: string
  files: FileMetadata[]
  children: FolderNode[]
}

function normalizeFolderPath(value?: string): string {
  if (!value) return ""
  const trimmed = value.trim()
  if (!trimmed) return ""
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  return withLeadingSlash.replace(/\/+/g, "/").replace(/\/$/, "")
}

function buildFolderTree(files: FileMetadata[]): FolderNode {
  const root: FolderNode = {
    id: "root",
    name: "root",
    path: "",
    files: [],
    children: [],
  }

  for (const file of files) {
    const normalizedPath = normalizeFolderPath(file.folder_path)
    if (!normalizedPath) {
      root.files.push(file)
      continue
    }

    const parts = normalizedPath.split("/").filter(Boolean)
    let current = root
    let runningPath = ""

    for (const part of parts) {
      runningPath = `${runningPath}/${part}`
      let child = current.children.find((node) => node.path === runningPath)
      if (!child) {
        child = {
          id: runningPath,
          name: part,
          path: runningPath,
          files: [],
          children: [],
        }
        current.children.push(child)
      }
      current = child
    }

    current.files.push(file)
  }

  const sortNode = (node: FolderNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.files.sort((a, b) => a.file_name.localeCompare(b.file_name))
    node.children.forEach(sortNode)
  }
  sortNode(root)

  return root
}

function countNodeFiles(node: FolderNode): number {
  return node.files.length + node.children.reduce((sum, child) => sum + countNodeFiles(child), 0)
}

export function BidDocumentsTab({ files }: BidDocumentsTabProps) {
  const folderTree = buildFolderTree(files)

  const renderFileRow = (file: FileMetadata, nested = false) => {
    const FileIcon = getFileIcon(file.mime_type)

    return (
      <div
        key={file.id}
        className={`flex items-center justify-between gap-3 rounded-lg border p-3 bg-muted/30 ${nested ? "ml-2" : ""}`}
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
  }

  const renderFolderNode = (node: FolderNode): React.ReactNode => (
    <details key={node.path} open className="rounded-md border bg-background/60">
      <summary className="cursor-pointer list-none px-3 py-2.5 hover:bg-muted/40">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <p className="truncate text-sm font-medium">{node.name}</p>
          </div>
          <Badge variant="secondary" className="text-[10px]">
            {countNodeFiles(node)}
          </Badge>
        </div>
      </summary>
      <div className="border-t px-2 py-2">
        <div className="space-y-2">
          {node.children.map((child) => renderFolderNode(child))}
          {node.files.map((file) => renderFileRow(file, true))}
        </div>
      </div>
    </details>
  )

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
          {folderTree.children.map((node) => renderFolderNode(node))}
          {folderTree.files.length > 0 && (
            <div className="rounded-md border bg-background/60">
              <div className="border-b px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Unsorted
              </div>
              <div className="space-y-2 p-2">
                {folderTree.files.map((file) => renderFileRow(file))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
