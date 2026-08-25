"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, FolderClosed, Loader2, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useDocuments } from "../documents-context"
import { normalizeFolderPath } from "./folder-path"

interface MoveFilesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  fileIds: string[]
  /** Owned by the layout because drag-and-drop moves share the same handler. */
  isMoving: boolean
  onMoveFiles: (
    fileIds: string[],
    targetPath: string | null,
    targetLabel: string,
  ) => Promise<void>
  /** Hands off to the create-folder dialog with a pre-filled path. */
  onRequestNewFolder: (suggestedPath: string) => void
}

export function MoveFilesDialog({
  open,
  onOpenChange,
  fileIds,
  isMoving,
  onMoveFiles,
  onRequestNewFolder,
}: MoveFilesDialogProps) {
  const { files, folders, currentPath } = useDocuments()
  const [targetFolder, setTargetFolder] = useState("")
  const [searchQuery, setSearchQuery] = useState("")

  useEffect(() => {
    if (!open) return
    setTargetFolder(currentPath || "")
    setSearchQuery("")
  }, [open, currentPath])

  // Where the selected files live now. A destination they already share is not
  // a move, so it is offered as "current folder" and cannot be submitted —
  // matching how drag-and-drop refuses the same drop.
  const originPath = useMemo(() => {
    const selected = files.filter((file) => fileIds.includes(file.id))
    if (selected.length === 0) return null
    const paths = new Set(selected.map((file) => normalizeFolderPath(file.folder_path ?? "") ?? ""))
    return paths.size === 1 ? (paths.values().next().value ?? "") : null
  }, [files, fileIds])

  const isNoOpTarget = useCallback(
    (path: string) => originPath !== null && (normalizeFolderPath(path) ?? "") === originPath,
    [originPath],
  )

  const targetIsNoOp = isNoOpTarget(targetFolder)

  const folderOptions = useMemo(() => {
    const allFolderPaths = new Set<string>(folders)
    for (const file of files) {
      if (file.folder_path) {
        const normalized = normalizeFolderPath(file.folder_path)
        if (normalized) {
          allFolderPaths.add(normalized)
        }
      }
    }
    return Array.from(allFolderPaths).sort((a, b) => a.localeCompare(b))
  }, [files, folders])

  const filteredFolderOptions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return folderOptions
    return folderOptions.filter((folder) => folder.toLowerCase().includes(query))
  }, [folderOptions, searchQuery])

  const handleConfirm = useCallback(async () => {
    if (fileIds.length === 0 || isNoOpTarget(targetFolder)) return

    const normalizedTarget = normalizeFolderPath(targetFolder)
    await onMoveFiles(fileIds, normalizedTarget, normalizedTarget ?? "Root")
    onOpenChange(false)
  }, [fileIds, targetFolder, onMoveFiles, onOpenChange, isNoOpTarget])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Move files</DialogTitle>
          <DialogDescription>
            Pick a destination from your existing folders. Create a new folder only when you need one.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Selected
                </p>
                <p className="mt-2 text-sm">
                  Move {fileIds.length} file{fileIds.length === 1 ? "" : "s"} to{" "}
                  <span className="font-medium">{targetFolder || "Root"}</span>.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isMoving}
                onClick={() => {
                  const trimmed = searchQuery.trim()
                  onOpenChange(false)
                  onRequestNewFolder(
                    trimmed ? `/${trimmed.replace(/^\/+/, "")}` : currentPath || "",
                  )
                }}
              >
                New folder
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {fileIds.slice(0, 3).map((fileId) => {
                const file = files.find((item) => item.id === fileId)
                if (!file) return null
                return (
                  <div
                    key={fileId}
                    className="max-w-full rounded-md border bg-background px-3 py-1.5 text-sm"
                  >
                    <span className="block truncate">{file.file_name}</span>
                  </div>
                )
              })}
              {fileIds.length > 3 ? (
                <div className="rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground">
                  +{fileIds.length - 3} more
                </div>
              ) : null}
            </div>
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter folders"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-9"
              disabled={isMoving}
            />
          </div>

          <div className="grid gap-2">
            <button
              type="button"
              onClick={() => setTargetFolder("")}
              className={cn(
                "flex items-center justify-between rounded-lg border px-4 py-3 text-left transition-colors",
                targetFolder === "" ? "border-primary bg-primary/5" : "hover:bg-muted/40",
                isNoOpTarget("") && "opacity-40",
              )}
              disabled={isMoving || isNoOpTarget("")}
            >
              <div className="flex items-center gap-3">
                <div className="rounded-md bg-muted p-2 text-muted-foreground">
                  <FolderClosed className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium">Root</p>
                  <p className="text-xs text-muted-foreground">
                    {isNoOpTarget("") ? "Already here." : "Keep these files at the top level."}
                  </p>
                </div>
              </div>
              {targetFolder === "" ? <Check className="h-4 w-4 text-primary" /> : null}
            </button>
            <ScrollArea className="max-h-64 rounded-lg border">
              <div className="space-y-1 p-2">
                {filteredFolderOptions.length === 0 ? (
                  <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                    No folders match that search. Use New folder to add one first.
                  </div>
                ) : (
                  filteredFolderOptions.map((folder) => (
                    <button
                      key={folder}
                      type="button"
                      onClick={() => setTargetFolder(folder)}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                        targetFolder === folder ? "bg-primary/10 text-primary" : "hover:bg-muted/40",
                        isNoOpTarget(folder) && "opacity-40",
                      )}
                      disabled={isMoving || isNoOpTarget(folder)}
                    >
                      <span className="truncate">{folder}</span>
                      {isNoOpTarget(folder) ? (
                        <span className="ml-2 shrink-0 text-xs text-muted-foreground">Current folder</span>
                      ) : targetFolder === folder ? (
                        <Check className="h-4 w-4 shrink-0" />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMoving}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isMoving || fileIds.length === 0 || targetIsNoOp}>
            {isMoving ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Moving...
              </>
            ) : (
              "Move"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
