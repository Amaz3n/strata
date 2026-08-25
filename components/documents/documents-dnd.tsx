"use client"

import { createContext, useContext, useMemo, type CSSProperties, type ReactNode } from "react"
import {
  closestCenter,
  pointerWithin,
  useDroppable,
  type Announcements,
  type CollisionDetection,
  type Modifier,
  type ScreenReaderInstructions,
} from "@dnd-kit/core"
import { getEventCoordinates } from "@dnd-kit/utilities"
import { FileText, FolderOpen, Files } from "lucide-react"
import { cn } from "@/lib/utils"
import { normalizeFolderPath } from "./dialogs/folder-path"

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * Where a drop target lives on screen.
 *
 * The same folder can be a target in three places at once — its row in the
 * table, its node in the explorer tree, and its chip in the breadcrumb dock —
 * and dnd-kit requires every droppable id to be unique, so the surface is part
 * of the id rather than something the drop handler has to disambiguate.
 */
export type DropSurface = "table" | "tree" | "dock"

const DROP_ID_PREFIX = "docdrop:"

/** `folderPath` is the canonical `/a/b` form, or `""` for the project root. */
export function documentsDropId(surface: DropSurface, folderPath: string): string {
  return `${DROP_ID_PREFIX}${surface}:${folderPath}`
}

export interface ParsedDropTarget {
  surface: DropSurface
  folderPath: string
}

export function parseDocumentsDropId(id: string): ParsedDropTarget | null {
  if (!id.startsWith(DROP_ID_PREFIX)) return null
  const rest = id.slice(DROP_ID_PREFIX.length)
  const separator = rest.indexOf(":")
  if (separator === -1) return null
  const surface = rest.slice(0, separator)
  if (surface !== "table" && surface !== "tree" && surface !== "dock") return null
  // Folder names may contain colons, so everything past the first one is path.
  return { surface, folderPath: rest.slice(separator + 1) }
}

/** Canonical folder path: `/a/b` for a folder, `""` for the project root. */
export function normalizeDropPath(value: string | null | undefined): string {
  return normalizeFolderPath(value ?? "") ?? ""
}

export function folderLabel(folderPath: string): string {
  if (!folderPath) return "All files"
  const segments = folderPath.split("/").filter(Boolean)
  return segments[segments.length - 1] ?? "All files"
}

// ---------------------------------------------------------------------------
// Drag payload
// ---------------------------------------------------------------------------

/**
 * What a dragged row carries. The id list is resolved at render time from the
 * current selection, so a multi-select drag is a first-class payload rather
 * than a single id plus a hidden piece of React state.
 */
export interface FileDragPayload {
  fileIds: string[]
  primaryFileName: string
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

export function readFileDragPayload(data: unknown): FileDragPayload | null {
  if (typeof data !== "object" || data === null) return null
  if (!("fileIds" in data) || !("primaryFileName" in data)) return null
  const { fileIds, primaryFileName } = data
  if (!isStringArray(fileIds) || fileIds.length === 0) return null
  if (typeof primaryFileName !== "string") return null
  return { fileIds, primaryFileName }
}

function describeSelection(payload: FileDragPayload): string {
  return payload.fileIds.length === 1
    ? payload.primaryFileName
    : `${payload.fileIds.length} files`
}

// ---------------------------------------------------------------------------
// Drag state shared with every surface
// ---------------------------------------------------------------------------

export interface DocumentsDragState {
  /** Files being dragged right now. Empty when no internal drag is running. */
  draggedFileIds: string[]
  /** Distinct folders those files currently live in (`""` is the root). */
  originPaths: string[]
  /** Folder a drop would land in right now, or null when nothing is hovered. */
  overFolderPath: string | null
}

export const IDLE_DOCUMENTS_DRAG: DocumentsDragState = {
  draggedFileIds: [],
  originPaths: [],
  overFolderPath: null,
}

const DocumentsDragContext = createContext<DocumentsDragState>(IDLE_DOCUMENTS_DRAG)

export function DocumentsDragProvider({
  state,
  children,
}: {
  state: DocumentsDragState
  children: ReactNode
}) {
  return (
    <DocumentsDragContext.Provider value={state}>{children}</DocumentsDragContext.Provider>
  )
}

export function useDocumentsDrag(): DocumentsDragState {
  return useContext(DocumentsDragContext)
}

export interface FolderDropTarget {
  setNodeRef: (element: HTMLElement | null) => void
  isOver: boolean
  /** Every dragged file already lives here, so the target refuses the drop. */
  isBlocked: boolean
}

export function useFolderDropTarget(
  surface: DropSurface,
  folderPath: string,
): FolderDropTarget {
  const { draggedFileIds, originPaths } = useDocumentsDrag()
  // A drop that would not change where anything lives is not a drop. Blocking
  // it here keeps the no-op out of collision detection entirely, so it can
  // never toast "Moved 1 file" for a move that did nothing.
  const isBlocked =
    draggedFileIds.length > 0 &&
    originPaths.length > 0 &&
    originPaths.every((path) => path === folderPath)
  const { setNodeRef, isOver } = useDroppable({
    id: documentsDropId(surface, folderPath),
    disabled: isBlocked,
  })
  return { setNodeRef, isOver, isBlocked }
}

// ---------------------------------------------------------------------------
// Collision detection + drag overlay placement
// ---------------------------------------------------------------------------

/**
 * Pointer drags land only on a target the pointer is actually inside, so a drop
 * on empty space stays a non-event instead of snapping to the nearest folder.
 * Keyboard drags have no pointer, so they fall back to proximity.
 */
export const documentsCollisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args)

/**
 * dnd-kit sizes and positions the overlay from the dragged node, and a table row
 * is a full-width strip — left as-is the chip would trail hundreds of pixels
 * behind the cursor. This pins its top-left just off the pointer instead.
 * Returns the transform untouched for keyboard drags, which have no coordinates.
 */
export const followPointerModifier: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (!draggingNodeRect || !activatorEvent) return transform
  const coordinates = getEventCoordinates(activatorEvent)
  if (!coordinates) return transform
  return {
    ...transform,
    x: transform.x + coordinates.x - draggingNodeRect.left + 14,
    y: transform.y + coordinates.y - draggingNodeRect.top + 14,
  }
}

/** Lets the overlay hug the chip instead of inheriting the row's dimensions. */
export const DRAG_OVERLAY_STYLE: CSSProperties = { width: "auto", height: "auto" }

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

export const documentsDragInstructions: ScreenReaderInstructions = {
  draggable:
    "To move this file to another folder, press space or enter. Use the arrow keys to travel to a folder, the explorer tree, or the breadcrumb bar. Press space or enter again to drop, or escape to cancel. The Move action in the row menu does the same thing through a dialog.",
}

export const documentsDragAnnouncements: Announcements = {
  onDragStart({ active }) {
    const payload = readFileDragPayload(active.data.current)
    if (!payload) return undefined
    return `Picked up ${describeSelection(payload)}. Use the arrow keys to move over a folder, then space or enter to drop.`
  },
  onDragOver({ active, over }) {
    const payload = readFileDragPayload(active.data.current)
    if (!payload) return undefined
    const target = over ? parseDocumentsDropId(String(over.id)) : null
    if (!target) return `${describeSelection(payload)} is not over a folder.`
    return `${describeSelection(payload)} is over ${folderLabel(target.folderPath)}.`
  },
  onDragEnd({ active, over }) {
    const payload = readFileDragPayload(active.data.current)
    if (!payload) return undefined
    const target = over ? parseDocumentsDropId(String(over.id)) : null
    if (!target) return `${describeSelection(payload)} was dropped outside a folder and did not move.`
    return `Moving ${describeSelection(payload)} to ${folderLabel(target.folderPath)}.`
  },
  onDragCancel({ active }) {
    const payload = readFileDragPayload(active.data.current)
    if (!payload) return undefined
    return `Move cancelled. ${describeSelection(payload)} stayed where it was.`
  },
}

// ---------------------------------------------------------------------------
// Drag overlay chip
// ---------------------------------------------------------------------------

export function FileDragChip({
  payload,
  targetLabel,
}: {
  payload: FileDragPayload
  targetLabel: string | null
}) {
  const count = payload.fileIds.length
  return (
    <div
      className={cn(
        "flex w-fit max-w-[280px] items-center gap-2 border bg-card px-2.5 py-1.5 shadow-lg",
        targetLabel ? "border-primary" : "border-dashed",
      )}
    >
      <Files
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          targetLabel ? "text-primary" : "text-muted-foreground",
        )}
      />
      <div className="min-w-0">
        <p className="truncate text-[12px] font-medium leading-tight">
          {payload.primaryFileName}
          {count > 1 ? ` +${count - 1}` : ""}
        </p>
        <p
          className={cn(
            "truncate text-[11px] leading-tight tabular-nums",
            targetLabel ? "text-primary" : "text-muted-foreground",
          )}
        >
          {targetLabel
            ? `Move ${count} ${count === 1 ? "file" : "files"} to ${targetLabel}`
            : "Drop on a folder to move"}
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Breadcrumb drop dock
// ---------------------------------------------------------------------------

function DockChip({ folderPath }: { folderPath: string }) {
  const { setNodeRef, isOver, isBlocked } = useFolderDropTarget("dock", folderPath)
  const Icon = folderPath ? FolderOpen : FileText

  return (
    <span
      ref={setNodeRef}
      className={cn(
        "flex shrink-0 items-center gap-1.5 border border-transparent px-2 py-1 text-xs transition-colors duration-150",
        isBlocked && "opacity-40",
        isOver
          ? "border-primary bg-primary/15 font-medium text-primary"
          : "text-muted-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {folderLabel(folderPath)}
    </span>
  )
}

/**
 * The way back out of a folder.
 *
 * Folder rows only ever point deeper, so without this a file could only be
 * moved further down the tree. The breadcrumb is already how people go up, so
 * the parent chain becomes the drop target: root, then every ancestor of the
 * open folder. It floats over the list only while files are in hand — reserving
 * a permanent strip would add idle chrome, and inserting one mid-drag would
 * shift the rows out from under the cursor.
 */
export function FolderDropDock({ currentPath }: { currentPath: string }) {
  const { draggedFileIds } = useDocumentsDrag()
  const normalizedPath = normalizeDropPath(currentPath)

  const ancestors = useMemo(() => {
    const segments = normalizedPath.split("/").filter(Boolean)
    const paths = [""]
    let accumulated = ""
    for (const segment of segments.slice(0, -1)) {
      accumulated += `/${segment}`
      paths.push(accumulated)
    }
    return paths
  }, [normalizedPath])

  // At the root there is nothing above the open folder to offer.
  if (draggedFileIds.length === 0 || !normalizedPath) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div className="flex max-w-full items-center gap-1 overflow-x-auto border bg-popover px-2 py-1.5 shadow-lg">
        <span className="shrink-0 px-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
          Move up to
        </span>
        {ancestors.map((path) => (
          <DockChip key={path || "root"} folderPath={path} />
        ))}
      </div>
    </div>
  )
}
