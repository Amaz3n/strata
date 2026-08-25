"use client"

import { useEffect, useMemo } from "react"
import { cn } from "@/lib/utils"
import {
  ChevronRight,
  FileText,
  FolderClosed,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ProjectFolderPermissions } from "@/app/(app)/documents/types"
import type { FolderNode } from "./types"
import { buildFolderTree, useDocuments } from "./documents-context"
import { useFolderDropTarget } from "./documents-dnd"
import { FileSharingBadges, getFolderSharingState } from "./file-badges"
interface DocumentsExplorerProps {
  className?: string
  onRenameFolder?: (path: string) => void
  onDeleteFolder?: (path: string) => void
  onShareFolder?: (path: string) => void
}

export function DocumentsExplorer({ 
  className,
  onRenameFolder,
  onDeleteFolder,
  onShareFolder,
}: DocumentsExplorerProps) {
  const {
    files,
    totalCount,
    folders,
    folderItemCounts,
    folderPermissions,
    currentPath,
    loadFolderChildren,
    navigateToRoot,
    navigateToFolder,
    expandedFolders,
    toggleFolderExpanded,
  } = useDocuments()

  const folderTree = useMemo(
    () => buildFolderTree(folders, files, folderItemCounts),
    [folders, files, folderItemCounts],
  )

  // The tree is the only surface that can reach every folder at once, so it is
  // also the only way to drag a file sideways or all the way back to the root.
  const rootDrop = useFolderDropTarget("tree", "")

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-10 items-center border-b bg-muted/40 px-4">
        <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Explorer
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-5 px-3 pb-4 pt-3">
          <section className="space-y-1.5">
            <button
              type="button"
              ref={rootDrop.setNodeRef}
              onClick={navigateToRoot}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm transition-colors duration-150",
                !currentPath
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                rootDrop.isBlocked && "opacity-40",
                rootDrop.isOver &&
                  "bg-primary/15 text-primary ring-1 ring-inset ring-primary hover:bg-primary/15 hover:text-primary",
              )}
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">All Files</span>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                {totalCount}
              </span>
            </button>

            {folderTree.length > 0 ? (
              <div className="space-y-0.5 pt-1">
                {folderTree.map((node) => (
                  <FolderTreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    currentPath={currentPath}
                    expandedFolders={expandedFolders}
                    folderPermissions={folderPermissions}
                    onLoadChildren={loadFolderChildren}
                    onToggle={toggleFolderExpanded}
                    onNavigate={navigateToFolder}
                    onRename={onRenameFolder}
                    onDelete={onDeleteFolder}
                    onShare={onShareFolder}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-1 text-xs text-muted-foreground">No folders yet.</p>
            )}
          </section>
        </div>
      </ScrollArea>
    </div>
  )
}

function FolderTreeNode({
  node,
  depth,
  currentPath,
  expandedFolders,
  folderPermissions,
  onLoadChildren,
  onToggle,
  onNavigate,
  onRename,
  onDelete,
  onShare,
}: {
  node: FolderNode
  depth: number
  currentPath: string
  expandedFolders: Set<string>
  folderPermissions: ProjectFolderPermissions[]
  onLoadChildren: (path?: string) => Promise<void>
  onToggle: (path: string) => void
  onNavigate: (path: string) => void
  onRename?: (path: string) => void
  onDelete?: (path: string) => void
  onShare?: (path: string) => void
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = expandedFolders.has(node.path)
  const isActive = currentPath === node.path

  const permissions = getFolderSharingState(folderPermissions, node.path)
  const hasSharingDefault = permissions.share_with_clients || permissions.share_with_subs
  const { setNodeRef, isOver, isBlocked } = useFolderDropTarget("tree", node.path)

  // Spring-loaded folders: resting on a collapsed node with files in hand opens
  // it, so a drag can reach a folder that was not already on screen.
  useEffect(() => {
    if (!isOver || !hasChildren || isExpanded) return
    const timer = window.setTimeout(() => {
      void onLoadChildren(node.path)
      onToggle(node.path)
    }, 600)
    return () => window.clearTimeout(timer)
  }, [isOver, hasChildren, isExpanded, node.path, onLoadChildren, onToggle])

  return (
    <div className="space-y-0.5">
      <div
        ref={setNodeRef}
        className={cn(
          "group flex items-center gap-1.5 transition-colors duration-150",
          isActive ? "bg-primary/10 text-primary" : "hover:bg-muted/60",
          isBlocked && "opacity-40",
          isOver && "bg-primary/15 text-primary ring-1 ring-inset ring-primary hover:bg-primary/15",
        )}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="inline-flex h-7 w-5 items-center justify-center text-muted-foreground"
            onClick={() => {
              if (!isExpanded) {
                void onLoadChildren(node.path)
              }
              onToggle(node.path)
            }}
            aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
          >
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")}
            />
          </button>
        ) : (
          <span className="inline-flex h-6 w-5 items-center justify-center text-muted-foreground">
            <ChevronRight className="h-3.5 w-3.5 opacity-0" />
          </span>
        )}

        <button
          type="button"
          onClick={() => onNavigate(node.path)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
        >
          {isExpanded && hasChildren ? (
            <FolderOpen className="h-4 w-4 shrink-0" />
          ) : (
            <FolderClosed className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate text-sm">{node.name}</span>
          {hasSharingDefault && (
            <span className="ml-auto flex items-center gap-0.5 pr-1 opacity-60 transition-opacity group-hover:opacity-100">
              <FileSharingBadges
                variant="icon"
                clients={permissions.share_with_clients}
                subs={permissions.share_with_subs}
                tooltips={{
                  clients: permissions.inherited
                    ? "Client sharing inherited"
                    : "Shared with clients",
                  subs: permissions.inherited
                    ? "Subcontractor sharing inherited"
                    : "Shared with subs",
                }}
              />
            </span>
          )}
        </button>

        <div className="pr-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
                <span className="sr-only">Folder actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onClick={() => onRename?.(node.path)}>
                <Pencil className="mr-2 h-4 w-4" />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onShare?.(node.path)}>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Sharing defaults...
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onDelete?.(node.path)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete folder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {hasChildren && isExpanded && (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              expandedFolders={expandedFolders}
              folderPermissions={folderPermissions}
              onLoadChildren={onLoadChildren}
              onToggle={onToggle}
              onNavigate={onNavigate}
              onRename={onRename}
              onDelete={onDelete}
              onShare={onShare}
            />
          ))}
        </div>
      )}
    </div>
  )
}
