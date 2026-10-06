"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Check, ChevronRight, FolderClosed, Loader2, Search } from "lucide-react"
import { listChildFoldersAction, listFoldersAction } from "@/app/(app)/documents/actions"
import { folderParent } from "../view-state"
import { Skeleton } from "@/components/ui/skeleton"
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
  const { files, projectId, currentPath } = useDocuments()
  const [targetFolder, setTargetFolder] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [browsePath, setBrowsePath] = useState("")
  const [folderOptions, setFolderOptions] = useState<string[]>([])
  const [isLoadingFolders, setIsLoadingFolders] = useState(false)
  const [folderError, setFolderError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [visibleLimit, setVisibleLimit] = useState(100)
  const searchIndexRef = useRef<Promise<string[]> | null>(null)

  useEffect(() => {
    if (!open) return
    searchIndexRef.current = null
    setTargetFolder(currentPath || "")
    setSearchQuery("")
    setBrowsePath(currentPath || "")
  }, [open, currentPath, projectId])

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

  // This browser owns its listing; opening the main Explorer is never a prerequisite.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoadingFolders(true)
    setFolderError(null)
    setFolderOptions([])
    setVisibleLimit(100)
    const query = searchQuery.trim().toLowerCase()
    const timeout = window.setTimeout(async () => {
      try {
        const paths = query
          ? (await (searchIndexRef.current ??= listFoldersAction(projectId))).filter((path) => path.toLowerCase().includes(query))
          : (await listChildFoldersAction(projectId, browsePath || undefined)).map((folder) => folder.path)
        if (!cancelled) setFolderOptions(paths.sort((a, b) => a.localeCompare(b)))
      } catch (error) {
        if (!cancelled) {
          searchIndexRef.current = null
          setFolderError(error instanceof Error ? error.message : "Could not load folders")
        }
      } finally {
        if (!cancelled) setIsLoadingFolders(false)
      }
    }, query ? 250 : 0)
    return () => { cancelled = true; window.clearTimeout(timeout) }
  }, [open, projectId, browsePath, searchQuery, retry])

  const filteredFolderOptions = folderOptions.slice(0, visibleLimit)

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
              placeholder="Search all project folders"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="pl-9"
              disabled={isMoving}
            />
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2 text-sm">
              <Button variant="ghost" size="sm" disabled={isMoving || !browsePath} onClick={() => { setSearchQuery(""); setBrowsePath(folderParent(browsePath)) }}>
                Up
              </Button>
              <span className="truncate text-muted-foreground">{searchQuery.trim() ? "Search results" : browsePath || "Root"}</span>
            </div>
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
                {isLoadingFolders ? (
                  <div className="space-y-2 p-2" aria-label="Loading folders">{[0, 1, 2].map((row) => <Skeleton key={row} className="h-8 w-full" />)}</div>
                ) : folderError ? (
                  <div className="p-3 text-sm" role="alert">{folderError}<Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div>
                ) : filteredFolderOptions.length === 0 ? (
                  <div className="px-2 py-8 text-center text-sm text-muted-foreground">
                    {searchQuery.trim() ? "No folders match that search." : "No subfolders here."} Use New folder to add one.
                  </div>
                ) : (
                  filteredFolderOptions.map((folder) => (
                    <div key={folder} className="flex items-center">
                    <button
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
                    <Button variant="ghost" size="icon" disabled={isMoving} aria-label={`Browse ${folder}`} onClick={() => { setSearchQuery(""); setBrowsePath(folder) }}>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    </div>
                  ))
                )}
                {!isLoadingFolders && folderOptions.length > visibleLimit && (
                  <Button variant="ghost" className="w-full" onClick={() => setVisibleLimit((limit) => limit + 100)}>Show more ({visibleLimit} of {folderOptions.length})</Button>
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
