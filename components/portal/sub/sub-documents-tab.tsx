"use client"

import { useState } from "react"
import { format } from "date-fns"
import { FileText, Download, Eye, Search } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { FileMetadata } from "@/lib/types"

interface SubDocumentsTabProps {
  files: FileMetadata[]
  canDownload?: boolean
}

const categoryLabels: Record<string, string> = {
  drawings: "Drawings",
  specs: "Specifications",
  contracts: "Contracts",
  submittals: "Submittals",
  photos: "Photos",
  correspondence: "Correspondence",
  other: "Other",
}

const categoryIcons: Record<string, string> = {
  drawings: "text-blue-500",
  specs: "text-purple-500",
  contracts: "text-green-500",
  submittals: "text-orange-500",
  photos: "text-pink-500",
  correspondence: "text-cyan-500",
  other: "text-gray-500",
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SubDocumentsTab({
  files,
  canDownload = true,
}: SubDocumentsTabProps) {
  const [search, setSearch] = useState("")
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)

  // Group files by category
  const filesByCategory = files.reduce(
    (acc, file) => {
      const category = file.category ?? "other"
      if (!acc[category]) acc[category] = []
      acc[category].push(file)
      return acc
    },
    {} as Record<string, FileMetadata[]>
  )

  // Filter files
  const filteredFiles = files.filter((file) => {
    const matchesSearch =
      !search || file.file_name.toLowerCase().includes(search.toLowerCase())
    const matchesCategory =
      !selectedCategory || file.category === selectedCategory
    return matchesSearch && matchesCategory
  })

  const categories = Object.keys(filesByCategory)

  if (files.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="h-12 w-12 mx-auto text-muted-foreground mb-3" />
        <p className="text-muted-foreground">No documents shared yet</p>
        <p className="text-sm text-muted-foreground">
          Drawings, specs, and other project documents will appear here
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Search and Filter */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search documents..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {/* Category Pills */}
      <div className="flex gap-2 flex-wrap">
        <Button
          size="sm"
          variant={selectedCategory === null ? "default" : "outline"}
          onClick={() => setSelectedCategory(null)}
        >
          All ({files.length})
        </Button>
        {categories.map((category) => (
          <Button
            key={category}
            size="sm"
            variant={selectedCategory === category ? "default" : "outline"}
            onClick={() => setSelectedCategory(category)}
          >
            {categoryLabels[category] ?? category} (
            {filesByCategory[category].length})
          </Button>
        ))}
      </div>

      {/* File List */}
      <Card>
        <CardContent className="p-0 divide-y">
          {filteredFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No documents match your search
            </p>
          ) : (
            filteredFiles.map((file) => (
              <div
                key={file.id}
                className="flex items-center gap-3 p-3 hover:bg-muted/50"
              >
                <div
                  className={`shrink-0 ${categoryIcons[file.category ?? "other"]}`}
                >
                  <FileText className="h-8 w-8" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{file.file_name}</p>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{categoryLabels[file.category ?? "other"]}</span>
                    <span>·</span>
                    <span>{format(new Date(file.created_at), "MMM d, yyyy")}</span>
                    {file.file_size && (
                      <>
                        <span>·</span>
                        <span>{formatFileSize(file.file_size)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {file.url && (
                    <Button size="icon" variant="ghost" asChild>
                      <a href={file.url} target="_blank" rel="noopener noreferrer">
                        <Eye className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  {canDownload && file.url && (
                    <Button size="icon" variant="ghost" asChild>
                      <a href={file.url} download={file.file_name}>
                        <Download className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
