"use client"

import { type ReactNode, useEffect, useState } from "react"
import { GripVertical } from "lucide-react"

import { cn } from "@/lib/utils"

interface WorkspaceShellProps {
  /** Whether the workspace is open. When false, nothing renders. */
  open: boolean
  /** Called when the user closes the workspace (Escape, backdrop intent, etc.). */
  onClose: () => void
  /** Left panel (record list). Rendered inside a fixed-width aside on md+. */
  listPanel: ReactNode
  /** Center column (the editable detail). */
  children: ReactNode
  /** Right panel (document viewer). Width is controlled by the draggable divider. */
  documentPane: ReactNode
  /** Initial width of the document pane in px. */
  defaultRightWidth?: number
}

/**
 * Generic full-screen, 3-pane workspace scaffold: left record list, center detail,
 * resizable right document pane. Owns the mechanical chrome (draggable divider,
 * escape-to-close, immersive-view dispatch) so domain workspaces only provide content.
 *
 * Modeled on the chrome in components/payables/payables-workspace.tsx; kept separate so
 * payables can adopt it later without being refactored now.
 */
export function WorkspaceShell({
  open,
  onClose,
  listPanel,
  children,
  documentPane,
  defaultRightWidth = 550,
}: WorkspaceShellProps) {
  const [rightPaneWidth, setRightPaneWidth] = useState(defaultRightWidth)
  const [isDraggingBorder, setIsDraggingBorder] = useState(false)

  const startDragging = (event: React.MouseEvent) => {
    event.preventDefault()
    setIsDraggingBorder(true)
  }

  useEffect(() => {
    if (!isDraggingBorder) return

    const handleMouseMove = (event: MouseEvent) => {
      const newWidth = window.innerWidth - event.clientX
      const minWidth = 280
      const maxWidth = Math.min(850, window.innerWidth * 0.6)
      if (newWidth >= minWidth && newWidth <= maxWidth) {
        setRightPaneWidth(newWidth)
      }
    }
    const handleMouseUp = () => setIsDraggingBorder(false)

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [isDraggingBorder])

  // Hide immersive chrome (mobile bottom nav) while the workspace is open.
  useEffect(() => {
    if (typeof window === "undefined" || !open) return
    window.dispatchEvent(new CustomEvent("arc-immersive-view", { detail: { active: true } }))
    return () => {
      window.dispatchEvent(new CustomEvent("arc-immersive-view", { detail: { active: false } }))
    }
  }, [open])

  // Close on Escape.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex bg-background">
      {/* LEFT: record list */}
      <aside className="hidden w-[300px] shrink-0 flex-col border-r bg-muted/10 md:flex">{listPanel}</aside>

      {/* CENTER: detail */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>

      {/* Draggable divider */}
      <div
        className={cn(
          "relative z-30 hidden w-[1px] cursor-col-resize select-none bg-border transition-colors hover:bg-primary/50 lg:block",
          isDraggingBorder && "bg-primary",
        )}
        onMouseDown={startDragging}
      >
        {/* Invisible wider hover area for easy dragging */}
        <div className="absolute inset-y-0 -left-1.5 -right-1.5 z-30 cursor-col-resize" />
        {/* Drag handle */}
        <div className="absolute left-1/2 top-1/2 z-40 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 cursor-col-resize select-none items-center justify-center rounded-full border bg-background shadow-md hover:bg-muted">
          <GripVertical className="h-5 w-5 text-muted-foreground" />
        </div>
      </div>

      {/* RIGHT: document viewer */}
      <aside style={{ width: `${rightPaneWidth}px` }} className="hidden shrink-0 bg-background lg:block">
        {documentPane}
      </aside>
    </div>
  )
}
