"use client"

import { useState, useEffect } from "react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { X } from "@/components/icons"
import { FILE_CATEGORIES, type FileCategory } from "@/components/files/types"
import type { FileWithUrls, FileUpdate } from "./actions"
import { formatFileSize } from "@/components/files/types"

interface FileMetadataSheetProps {
  file: FileWithUrls | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (fileId: string, updates: FileUpdate) => Promise<void>
}

export function FileMetadataSheet({
  file,
  open,
  onOpenChange,
  onSave,
}: FileMetadataSheetProps) {
  const [fileName, setFileName] = useState("")
  const [category, setCategory] = useState<FileCategory | undefined>()
  const [description, setDescription] = useState("")
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState("")
  const [folderPath, setFolderPath] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // Reset form when file changes
  useEffect(() => {
    if (file) {
      setFileName(file.file_name)
      setCategory(file.category as FileCategory | undefined)
      setDescription(file.description ?? "")
      setTags(file.tags ?? [])
      setFolderPath(file.folder_path ?? "")
    }
  }, [file])

  const handleAddTag = () => {
    const trimmed = tagInput.trim().toLowerCase()
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed])
    }
    setTagInput("")
  }

  const handleRemoveTag = (tag: string) => {
    setTags(tags.filter((t) => t !== tag))
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      handleAddTag()
    }
  }

  const handleSave = async () => {
    if (!file) return

    setIsSaving(true)
    try {
      await onSave(file.id, {
        file_name: fileName !== file.file_name ? fileName : undefined,
        category: category !== file.category ? (category ?? null) : undefined,
        description: description !== (file.description ?? "") ? (description || null) : undefined,
        tags: JSON.stringify(tags) !== JSON.stringify(file.tags ?? []) ? tags : undefined,
        folder_path: folderPath !== (file.folder_path ?? "") ? (folderPath || null) : undefined,
      })
    } finally {
      setIsSaving(false)
    }
  }

  if (!file) return null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Edit File Details</SheetTitle>
          <SheetDescription>
            Update metadata for this file. Changes are saved immediately.
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* File info (readonly) */}
          <div className="rounded-lg bg-muted p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Size</span>
              <span>{formatFileSize(file.size_bytes)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Type</span>
              <span>{file.mime_type ?? "Unknown"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Uploaded</span>
              <span>{new Date(file.created_at).toLocaleDateString()}</span>
            </div>
            {file.uploader_name && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">By</span>
                <span>{file.uploader_name}</span>
              </div>
            )}
          </div>

          {/* Editable fields */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fileName">File Name</Label>
              <Input
                id="fileName"
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="category">Category</Label>
              <Select
                value={category ?? ""}
                onValueChange={(value) =>
                  setCategory(value ? (value as FileCategory) : undefined)
                }
              >
                <SelectTrigger id="category">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No category</SelectItem>
                  {(Object.keys(FILE_CATEGORIES) as FileCategory[]).map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      <span className="flex items-center gap-2">
                        <span>{FILE_CATEGORIES[cat].icon}</span>
                        {FILE_CATEGORIES[cat].label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add a description..."
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="folderPath">Folder Path</Label>
              <Input
                id="folderPath"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="/drawings/structural"
              />
              <p className="text-xs text-muted-foreground">
                Organize files using virtual folder paths
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tags">Tags</Label>
              <div className="flex gap-2">
                <Input
                  id="tags"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Add a tag..."
                />
                <Button type="button" variant="outline" onClick={handleAddTag}>
                  Add
                </Button>
              </div>
              {tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2">
                  {tags.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1">
                      {tag}
                      <button
                        type="button"
                        onClick={() => handleRemoveTag(tag)}
                        className="ml-1 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4 border-t">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save Changes"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
