"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
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
import { createFolderAction } from "@/app/(app)/documents/actions"
import { useDocuments } from "../documents-context"
import { normalizeFolderPath } from "./folder-path"

interface CreateFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-filled path — the current folder, or a name typed into the move dialog. */
  initialPath: string
}

export function CreateFolderDialog({
  open,
  onOpenChange,
  initialPath,
}: CreateFolderDialogProps) {
  const { projectId, refreshFiles } = useDocuments()
  const [path, setPath] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    setPath(initialPath)
  }, [open, initialPath])

  const handleConfirm = useCallback(async () => {
    const normalized = normalizeFolderPath(path)
    if (!normalized) {
      toast.error("Enter a folder path like /contracts")
      return
    }

    setIsCreating(true)
    try {
      unwrapAction(await createFolderAction(projectId, normalized))
      toast.success(`Created folder ${normalized}`)
      onOpenChange(false)
      await refreshFiles({ invalidateCache: true })
    } catch (error) {
      console.error("Failed to create folder:", error)
      toast.error(error instanceof Error ? error.message : "Failed to create folder")
    } finally {
      setIsCreating(false)
    }
  }, [path, projectId, onOpenChange, refreshFiles])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create folder</DialogTitle>
          <DialogDescription>
            Folders are virtual and support nested paths like{" "}
            <code>/contracts/subcontracts</code>.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            placeholder="/contracts"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            disabled={isCreating}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isCreating}>
            {isCreating ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              "Create"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
