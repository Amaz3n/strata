"use client"

import { useMemo } from "react"
import { cn } from "@/lib/utils"
import {
  AlertCircle,
  ChevronRight,
  FileText,
  FolderClosed,
  FolderOpen,
  Layers,
  Loader2,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { DrawingSet } from "@/app/(app)/drawings/actions"
import type { FolderNode } from "./types"
import { buildFolderTree, useDocuments } from "./documents-context"

interface DocumentsExplorerProps {
  className?: string
}

function filterFolderTree(nodes: FolderNode[], query: string): FolderNode[] {
  if (!query) return nodes
  const q = query.toLowerCase()
  return nodes
    .map((node) => {
      const children = filterFolderTree(node.children, query)
      const selfMatches =
        node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)
      if (!selfMatches && children.length === 0) return null
      return {
        ...node,
        children,
      }
    })
    .filter((node): node is FolderNode => Boolean(node))
}

function statusTone(set: DrawingSet): string {
  if (set.status === "failed") return "text-red-600"
  if (set.status === "processing") return "text-amber-600"
  return "text-emerald-600"
}

export function DocumentsExplorer({ className }: DocumentsExplorerProps) {
  const {
    files,
    folders,
    drawingSets,
    searchQuery,
    currentPath,
    selectedDrawingSetId,
    navigateToRoot,
    navigateToFolder,
    navigateToDrawingSet,
    expandedFolders,
    toggleFolderExpanded,
  } = useDocuments()
  const query = searchQuery.trim()

  const folderTree = useMemo(() => buildFolderTree(folders, files), [folders, files])
  const filteredTree = useMemo(
    () => filterFolderTree(folderTree, query),
    [folderTree, query]
  )

  const visibleDrawingSets = useMemo(() => {
    if (!query) return drawingSets
    const q = query.toLowerCase()
    return drawingSets.filter((set) => {
      return (
        set.title.toLowerCase().includes(q) ||
        (set.description ?? "").toLowerCase().includes(q) ||
        (set.set_type ?? "").toLowerCase().includes(q)
      )
    })
  }, [drawingSets, query])

  const isFilterActive = query.length > 0

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="border-b border-border/60 px-3 pb-2 pt-3">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Explorer
        </p>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-4 px-2 pb-4 pt-3">
          <section className="space-y-1">
            <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Files
            </p>
            <button
              type="button"
              onClick={navigateToRoot}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                !selectedDrawingSetId && !currentPath
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              )}
            >
              <FileText className="h-4 w-4 shrink-0" />
              <span className="truncate">All Files</span>
              <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                {files.length}
              </span>
            </button>

            {filteredTree.length > 0 ? (
              <div className="space-y-0.5 pt-1">
                {filteredTree.map((node) => (
                  <FolderTreeNode
                    key={node.path}
                    node={node}
                    depth={0}
                    currentPath={currentPath}
                    selectedDrawingSetId={selectedDrawingSetId}
                    expandedFolders={expandedFolders}
                    onToggle={toggleFolderExpanded}
                    onNavigate={navigateToFolder}
                    forceExpanded={isFilterActive}
                  />
                ))}
              </div>
            ) : (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {isFilterActive ? "No folders match this search." : "No folders yet."}
              </p>
            )}
          </section>

          <section className="space-y-1">
            <p className="px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Drawing Sets
            </p>
            <div className="space-y-0.5">
              {visibleDrawingSets.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">
                  {isFilterActive ? "No drawing sets match this search." : "No drawing sets yet."}
                </p>
              )}
              {visibleDrawingSets.map((set) => (
                <button
                  key={set.id}
                  type="button"
                  onClick={() => navigateToDrawingSet(set.id, set.title)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    selectedDrawingSetId === set.id
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  {set.status === "processing" ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                  ) : set.status === "failed" ? (
                    <AlertCircle className={cn("h-4 w-4 shrink-0", statusTone(set))} />
                  ) : (
                    <Layers className="h-4 w-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{set.title}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {set.sheet_count ?? 0}
                  </span>
                </button>
              ))}
            </div>
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
  selectedDrawingSetId,
  expandedFolders,
  onToggle,
  onNavigate,
  forceExpanded = false,
}: {
  node: FolderNode
  depth: number
  currentPath: string
  selectedDrawingSetId: string | null
  expandedFolders: Set<string>
  onToggle: (path: string) => void
  onNavigate: (path: string) => void
  forceExpanded?: boolean
}) {
  const hasChildren = node.children.length > 0
  const isExpanded = forceExpanded || expandedFolders.has(node.path)
  const isActive = !selectedDrawingSetId && currentPath === node.path

  return (
    <div className="space-y-0.5">
      <div
        className={cn(
          "group flex items-center gap-1.5 rounded-md transition-colors",
          isActive ? "bg-primary/10 text-primary" : "hover:bg-muted/60"
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="inline-flex h-6 w-5 items-center justify-center text-muted-foreground"
            onClick={() => onToggle(node.path)}
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
          className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
        >
          {isExpanded && hasChildren ? (
            <FolderOpen className="h-4 w-4 shrink-0" />
          ) : (
            <FolderClosed className="h-4 w-4 shrink-0" />
          )}
          <span className="truncate text-sm">{node.name}</span>
        </button>
      </div>

      {hasChildren && isExpanded && (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              currentPath={currentPath}
              selectedDrawingSetId={selectedDrawingSetId}
              expandedFolders={expandedFolders}
              onToggle={onToggle}
              onNavigate={onNavigate}
              forceExpanded={forceExpanded}
            />
          ))}
        </div>
      )}
    </div>
  )
}
