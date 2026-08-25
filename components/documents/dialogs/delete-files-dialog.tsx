"use client"

import { useCallback, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
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
import { bulkDeleteFilesAction } from "@/app/(app)/documents/actions"

interface DeleteFilesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileIds: string[]
  /** Runs after a successful archive — clears selection and refreshes the list. */
  onDeleted: () => Promise<void>
}

export function DeleteFilesDialog({
  open,
  onOpenChange,
  fileIds,
  onDeleted,
}: DeleteFilesDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false)

  const handleConfirm = useCallback(async () => {
    if (fileIds.length === 0) return

    setIsDeleting(true)
    try {
      unwrapAction(await bulkDeleteFilesAction(fileIds))
      toast.success(
        `Moved ${fileIds.length} file${fileIds.length === 1 ? "" : "s"} to trash`,
      )
      onOpenChange(false)
      await onDeleted()
    } catch (error) {
      console.error("Failed to delete files:", error)
      toast.error("Failed to delete files")
    } finally {
      setIsDeleting(false)
    }
  }, [fileIds, onOpenChange, onDeleted])

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move files to trash?</AlertDialogTitle>
          <AlertDialogDescription>
            This will archive {fileIds.length} file
            {fileIds.length === 1 ? "" : "s"} so they are hidden from the active documents list and can be restored from a trash view.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Moving...
              </>
            ) : (
              "Move to trash"
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
