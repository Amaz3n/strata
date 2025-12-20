"use client"

import { useState, useCallback, useRef } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  Upload,
  Download,
  History,
  Check,
  Trash2,
  Edit2,
  MoreHorizontal,
  Clock,
  User,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { formatFileSize } from "./types"

export interface FileVersionInfo {
  id: string
  version_number: number
  label?: string
  notes?: string
  file_name?: string
  mime_type?: string
  size_bytes?: number
  creator_name?: string
  created_at: string
  is_current: boolean
}

interface VersionHistoryPanelProps {
  fileId: string
  fileName: string
  versions: FileVersionInfo[]
  onUploadVersion: (file: File, label?: string, notes?: string) => Promise<void>
  onMakeCurrent: (versionId: string) => Promise<void>
  onDownloadVersion: (versionId: string) => Promise<void>
  onUpdateVersion: (versionId: string, updates: { label?: string; notes?: string }) => Promise<void>
  onDeleteVersion: (versionId: string) => Promise<void>
  onRefresh: () => Promise<void>
  className?: string
}

export function VersionHistoryPanel({
  fileId,
  fileName,
  versions,
  onUploadVersion,
  onMakeCurrent,
  onDownloadVersion,
  onUpdateVersion,
  onDeleteVersion,
  onRefresh,
  className,
}: VersionHistoryPanelProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadLabel, setUploadLabel] = useState("")
  const [uploadNotes, setUploadNotes] = useState("")

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editVersion, setEditVersion] = useState<FileVersionInfo | null>(null)
  const [editLabel, setEditLabel] = useState("")
  const [editNotes, setEditNotes] = useState("")
  const [isEditing, setIsEditing] = useState(false)

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [versionToDelete, setVersionToDelete] = useState<FileVersionInfo | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const [makingCurrent, setMakingCurrent] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setUploadFile(file)
      setUploadDialogOpen(true)
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }, [])

  const handleUploadConfirm = useCallback(async () => {
    if (!uploadFile) return

    setIsUploading(true)
    try {
      await onUploadVersion(uploadFile, uploadLabel || undefined, uploadNotes || undefined)
      toast.success("New version uploaded")
      setUploadDialogOpen(false)
      setUploadFile(null)
      setUploadLabel("")
      setUploadNotes("")
      await onRefresh()
    } catch (error) {
      console.error("Upload failed:", error)
      toast.error("Failed to upload version")
    } finally {
      setIsUploading(false)
    }
  }, [uploadFile, uploadLabel, uploadNotes, onUploadVersion, onRefresh])

  const handleEditClick = useCallback((version: FileVersionInfo) => {
    setEditVersion(version)
    setEditLabel(version.label ?? "")
    setEditNotes(version.notes ?? "")
    setEditDialogOpen(true)
  }, [])

  const handleEditConfirm = useCallback(async () => {
    if (!editVersion) return

    setIsEditing(true)
    try {
      await onUpdateVersion(editVersion.id, {
        label: editLabel || undefined,
        notes: editNotes || undefined,
      })
      toast.success("Version updated")
      setEditDialogOpen(false)
      setEditVersion(null)
      await onRefresh()
    } catch (error) {
      console.error("Update failed:", error)
      toast.error("Failed to update version")
    } finally {
      setIsEditing(false)
    }
  }, [editVersion, editLabel, editNotes, onUpdateVersion, onRefresh])

  const handleDeleteClick = useCallback((version: FileVersionInfo) => {
    setVersionToDelete(version)
    setDeleteDialogOpen(true)
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!versionToDelete) return

    setIsDeleting(true)
    try {
      await onDeleteVersion(versionToDelete.id)
      toast.success("Version deleted")
      setDeleteDialogOpen(false)
      setVersionToDelete(null)
      await onRefresh()
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error("Failed to delete version")
    } finally {
      setIsDeleting(false)
    }
  }, [versionToDelete, onDeleteVersion, onRefresh])

  const handleMakeCurrent = useCallback(
    async (versionId: string) => {
      setMakingCurrent(versionId)
      try {
        await onMakeCurrent(versionId)
        toast.success("Version restored as current")
        await onRefresh()
      } catch (error) {
        console.error("Make current failed:", error)
        toast.error("Failed to restore version")
      } finally {
        setMakingCurrent(null)
      }
    },
    [onMakeCurrent, onRefresh]
  )

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return (
    <div className={cn("space-y-4", className)}>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="font-medium">Version History</h3>
          <Badge variant="secondary" className="text-xs">
            {versions.length} version{versions.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <Button size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload className="h-4 w-4 mr-2" />
          Upload New Version
        </Button>
      </div>

      {/* Version list */}
      <div className="space-y-2">
        {versions.length === 0 ? (
          <div className="text-sm text-muted-foreground text-center py-8">
            No versions recorded yet. Upload a new version to start tracking.
          </div>
        ) : (
          versions.map((version) => (
            <div
              key={version.id}
              className={cn(
                "flex items-start gap-3 p-3 rounded-lg border bg-card",
                version.is_current && "border-primary bg-primary/5"
              )}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">v{version.version_number}</span>
                  {version.label && (
                    <Badge variant="outline" className="text-xs">
                      {version.label}
                    </Badge>
                  )}
                  {version.is_current && (
                    <Badge className="text-xs">Current</Badge>
                  )}
                </div>
                {version.notes && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                    {version.notes}
                  </p>
                )}
                <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDate(version.created_at)}
                  </span>
                  {version.creator_name && (
                    <span className="flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {version.creator_name}
                    </span>
                  )}
                  {version.size_bytes && (
                    <span>{formatFileSize(version.size_bytes)}</span>
                  )}
                </div>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onDownloadVersion(version.id)}>
                    <Download className="h-4 w-4 mr-2" />
                    Download
                  </DropdownMenuItem>
                  {!version.is_current && (
                    <DropdownMenuItem
                      onClick={() => handleMakeCurrent(version.id)}
                      disabled={makingCurrent === version.id}
                    >
                      <Check className="h-4 w-4 mr-2" />
                      {makingCurrent === version.id ? "Restoring..." : "Make Current"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onClick={() => handleEditClick(version)}>
                    <Edit2 className="h-4 w-4 mr-2" />
                    Edit Label/Notes
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => handleDeleteClick(version)}
                    className="text-destructive"
                    disabled={version.is_current}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))
        )}
      </div>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload New Version</DialogTitle>
            <DialogDescription>
              Upload a new version of "{fileName}". The previous version will be preserved.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {uploadFile && (
              <div className="rounded-lg bg-muted p-3 text-sm">
                <p className="font-medium">{uploadFile.name}</p>
                <p className="text-muted-foreground">{formatFileSize(uploadFile.size)}</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="version-label">Version Label (optional)</Label>
              <Input
                id="version-label"
                value={uploadLabel}
                onChange={(e) => setUploadLabel(e.target.value)}
                placeholder="e.g., Rev A, Final, For Review"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="version-notes">Notes (optional)</Label>
              <Textarea
                id="version-notes"
                value={uploadNotes}
                onChange={(e) => setUploadNotes(e.target.value)}
                placeholder="Describe what changed in this version..."
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUploadConfirm} disabled={isUploading || !uploadFile}>
              {isUploading ? "Uploading..." : "Upload Version"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Version</DialogTitle>
            <DialogDescription>
              Update the label and notes for version {editVersion?.version_number}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="edit-label">Version Label</Label>
              <Input
                id="edit-label"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                placeholder="e.g., Rev A, Final, For Review"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-notes">Notes</Label>
              <Textarea
                id="edit-notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Describe what changed in this version..."
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleEditConfirm} disabled={isEditing}>
              {isEditing ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete version?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete version {versionToDelete?.version_number}
              {versionToDelete?.label && ` (${versionToDelete.label})`}? This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
