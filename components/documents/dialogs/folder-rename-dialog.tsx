"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { unwrapAction } from "@/lib/action-result"
import { renameFolderAction } from "@/app/(app)/documents/actions"
import { useDocuments } from "../documents-context"

interface FolderRenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Full path of the folder being renamed. */
  path: string
}

export function FolderRenameDialog({ open, onOpenChange, path }: FolderRenameDialogProps) {
  const { projectId, refreshFiles } = useDocuments()
  const [value, setValue] = useState("")
  const [isRenaming, setIsRenaming] = useState(false)

  useEffect(() => {
    if (!open) return
    const parts = path.split("/").filter(Boolean)
    setValue(parts[parts.length - 1] || "")
  }, [open, path])

  const handleConfirm = useCallback(async () => {
    if (!path || !value.trim()) return
    setIsRenaming(true)
    try {
      unwrapAction(await renameFolderAction(projectId, path, value.trim()))
      onOpenChange(false)
      await refreshFiles({ invalidateCache: true })
      toast.success("Folder renamed")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to rename folder")
    } finally {
      setIsRenaming(false)
    }
  }, [path, value, projectId, onOpenChange, refreshFiles])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename folder</DialogTitle>
          <DialogDescription>
            This will update the path for all files inside this folder.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Folder name"
            disabled={isRenaming}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isRenaming}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isRenaming || !value.trim()}>
            {isRenaming ? "Renaming..." : "Rename"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
