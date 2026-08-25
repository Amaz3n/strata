"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"
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
import { unwrapAction } from "@/lib/action-result"
import { deleteFolderAction } from "@/app/(app)/documents/actions"
import { useDocuments } from "../documents-context"

interface FolderDeleteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Full path of the folder being deleted. */
  path: string
}

export function FolderDeleteDialog({ open, onOpenChange, path }: FolderDeleteDialogProps) {
  const { projectId, refreshFiles } = useDocuments()
  const [isDeleting, setIsDeleting] = useState(false)

  const handleConfirm = useCallback(async () => {
    if (!path) return
    setIsDeleting(true)
    try {
      unwrapAction(await deleteFolderAction(projectId, path))
      onOpenChange(false)
      await refreshFiles({ invalidateCache: true })
      toast.success("Folder deleted")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete folder")
    } finally {
      setIsDeleting(false)
    }
  }, [path, projectId, onOpenChange, refreshFiles])

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete folder?</AlertDialogTitle>
          <AlertDialogDescription>
            Are you sure you want to delete this folder? This action cannot be undone and will also remove any folder-specific sharing defaults.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? "Deleting..." : "Delete Folder"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
