"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { Loader2, Sparkles } from "lucide-react"
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
import { suggestFileNameAction, updateFileAction } from "@/app/(app)/documents/actions"
import type { FileWithUrls } from "@/app/(app)/documents/types"
import { useDocuments } from "../documents-context"

interface RenameFileDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The document being renamed. Null while the dialog is closed. */
  file: FileWithUrls | null
}

export function RenameFileDialog({ open, onOpenChange, file }: RenameFileDialogProps) {
  const { refreshFiles } = useDocuments()
  const [value, setValue] = useState("")
  const [isRenaming, setIsRenaming] = useState(false)
  const [isSuggesting, setIsSuggesting] = useState(false)

  useEffect(() => {
    if (!open || !file) return
    setValue(file.file_name)
  }, [open, file])

  const handleConfirm = useCallback(async () => {
    if (!file) return
    const nextName = value.trim()
    if (!nextName) {
      toast.error("File name is required")
      return
    }

    setIsRenaming(true)
    try {
      unwrapAction(await updateFileAction(file.id, { file_name: nextName }))
      toast.success("File renamed")
      onOpenChange(false)
      await refreshFiles({ invalidateCache: true })
    } catch (error) {
      console.error("Failed to rename file:", error)
      toast.error("Failed to rename file")
    } finally {
      setIsRenaming(false)
    }
  }, [file, value, onOpenChange, refreshFiles])

  const handleSuggest = useCallback(async () => {
    if (!file) return

    setIsSuggesting(true)
    try {
      const result = await suggestFileNameAction(file.id)
      if (!result.ok) {
        toast.error("Could not suggest a name", { description: result.error })
        return
      }
      setValue(result.fileName)
      toast.success("AI name suggested")
    } catch (error) {
      console.error("Failed to suggest file name:", error)
      toast.error("Could not suggest a name")
    } finally {
      setIsSuggesting(false)
    }
  }, [file])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename file</DialogTitle>
          <DialogDescription>Update the file name shown in Documents.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              disabled={isRenaming || isSuggesting}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={handleSuggest}
              disabled={isRenaming || isSuggesting || !file}
              className="shrink-0 border border-primary/20 text-primary transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              {isSuggesting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 mr-2" />
              )}
              <span>AI rename</span>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            AI reads the file purpose, identifiers, vendors, trades, and scope to suggest a short project-ready name.
          </p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isRenaming || isSuggesting}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isRenaming || isSuggesting}>
            {isRenaming ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Saving...
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
