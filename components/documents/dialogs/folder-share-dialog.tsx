"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useProductTerminology } from "@/components/layout/use-product-terminology"
import { unwrapAction } from "@/lib/action-result"
import { updateFolderPermissionsAction } from "@/app/(app)/documents/actions"
import { useDocuments } from "../documents-context"
import { shareSummary } from "./share-summary"

/** Snapshot of a folder's sharing defaults, taken when the dialog is opened. */
export interface FolderShareTarget {
  path: string
  shareWithClients: boolean
  shareWithSubs: boolean
}

interface FolderShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  target: FolderShareTarget | null
}

export function FolderShareDialog({ open, onOpenChange, target }: FolderShareDialogProps) {
  const { projectId, refreshFiles, refreshFolderPermissions } = useDocuments()
  const terms = useProductTerminology()

  const [withClients, setWithClients] = useState(false)
  const [withSubs, setWithSubs] = useState(false)
  const [applyToExisting, setApplyToExisting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (!open || !target) return
    setWithClients(target.shareWithClients)
    setWithSubs(target.shareWithSubs)
    setApplyToExisting(false)
  }, [open, target])

  const handleConfirm = useCallback(async () => {
    if (!target?.path) return
    setIsSaving(true)
    try {
      unwrapAction(
        await updateFolderPermissionsAction(
          projectId,
          target.path,
          {
            share_with_clients: withClients,
            share_with_subs: withSubs,
          },
          applyToExisting,
        ),
      )
      onOpenChange(false)
      if (applyToExisting) {
        // refreshFiles already reloads folder permissions alongside the file list.
        await refreshFiles({ invalidateCache: true })
      } else {
        await refreshFolderPermissions()
      }
      toast.success("Folder permissions updated")
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update folder permissions",
      )
    } finally {
      setIsSaving(false)
    }
  }, [
    target,
    withClients,
    withSubs,
    applyToExisting,
    projectId,
    onOpenChange,
    refreshFiles,
    refreshFolderPermissions,
  ])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share folder</DialogTitle>
          <DialogDescription className="truncate">
            {target?.path || "Root"}
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          <div className="divide-y rounded-lg border">
            <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{terms.ownerPortal}</p>
                <p className="text-xs text-muted-foreground">
                  New uploads default to the {terms.ownerPortal.toLowerCase()}.
                </p>
              </div>
              <Switch
                checked={withClients}
                onCheckedChange={(value) => setWithClients(Boolean(value))}
                disabled={isSaving}
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Subcontractor portal</p>
                <p className="text-xs text-muted-foreground">
                  New uploads default to the subcontractor portal.
                </p>
              </div>
              <Switch
                checked={withSubs}
                onCheckedChange={(value) => setWithSubs(Boolean(value))}
                disabled={isSaving}
              />
            </label>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {shareSummary(withClients, withSubs, terms.owners)}
          </p>
          <label className="mt-4 flex cursor-pointer items-start gap-2">
            <Checkbox
              checked={applyToExisting}
              onCheckedChange={(value) => setApplyToExisting(Boolean(value))}
              disabled={isSaving}
              className="mt-0.5"
            />
            <span className="text-xs text-muted-foreground">
              Apply to existing files in this folder. Otherwise, only new uploads are affected.
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving
              </>
            ) : (
              "Save"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
