"use client"

import { useEffect, useCallback, useRef } from "react"

export interface KeyboardShortcutHandlers {
  onNextSheet?: () => void
  onPreviousSheet?: () => void
  onOpenSheet?: () => void
  onSearch?: () => void
  onEscape?: () => void
  onFilterDiscipline?: (discipline: string | null) => void
  onToggleView?: () => void
  onZoomIn?: () => void
  onZoomOut?: () => void
  onFitToScreen?: () => void
  onZoom100?: () => void
  onToggleMarkup?: () => void
  onTogglePins?: () => void
  onDownload?: () => void
  onShowHelp?: () => void
  onToggleComparison?: () => void
}

export interface UseDrawingKeyboardShortcutsOptions {
  enabled?: boolean
  context: "list" | "viewer"
  handlers: KeyboardShortcutHandlers
}

const DISCIPLINE_KEYS: Record<string, string | null> = {
  a: "A", // Architectural
  s: "S", // Structural
  m: "M", // Mechanical
  e: "E", // Electrical
  p: "P", // Plumbing
  c: "C", // Civil
  l: "L", // Landscape
  f: "FP", // Fire Protection
  g: null, // Clear filter (show all)
}

export function useDrawingKeyboardShortcuts({
  enabled = true,
  context,
  handlers,
}: UseDrawingKeyboardShortcutsOptions) {
  const pendingGoto = useRef(false)
  const pendingGotoTimeout = useRef<NodeJS.Timeout | undefined>(undefined)

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in inputs
      const target = event.target as HTMLElement
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        // Allow Escape to blur inputs
        if (event.key === "Escape") {
          target.blur()
          handlers.onEscape?.()
        }
        return
      }

      const key = event.key.toLowerCase()

      // Handle "g then X" sequences for discipline filtering
      if (pendingGoto.current) {
        pendingGoto.current = false
        clearTimeout(pendingGotoTimeout.current)

        if (key in DISCIPLINE_KEYS) {
          event.preventDefault()
          handlers.onFilterDiscipline?.(DISCIPLINE_KEYS[key])
          return
        }
      }

      // Start "g" sequence (only in list context)
      if (key === "g" && !event.metaKey && !event.ctrlKey && context === "list") {
        pendingGoto.current = true
        // Reset after 1 second if no follow-up key
        pendingGotoTimeout.current = setTimeout(() => {
          pendingGoto.current = false
        }, 1000)
        return
      }

      // Prevent default for our shortcuts
      const handled = handleShortcut(key, event, context, handlers)
      if (handled) {
        event.preventDefault()
      }
    },
    [context, handlers]
  )

  useEffect(() => {
    if (!enabled) return

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      clearTimeout(pendingGotoTimeout.current)
    }
  }, [enabled, handleKeyDown])
}

function handleShortcut(
  key: string,
  event: KeyboardEvent,
  context: "list" | "viewer",
  handlers: KeyboardShortcutHandlers
): boolean {
  // Universal shortcuts
  switch (key) {
    case "escape":
      handlers.onEscape?.()
      return true
    case "?":
      if (event.shiftKey) {
        handlers.onShowHelp?.()
        return true
      }
      break
    case "/":
      handlers.onSearch?.()
      return true
  }

  // Context-specific shortcuts
  if (context === "list") {
    switch (key) {
      case "j":
      case "arrowdown":
        handlers.onNextSheet?.()
        return true
      case "k":
      case "arrowup":
        handlers.onPreviousSheet?.()
        return true
      case "enter":
        handlers.onOpenSheet?.()
        return true
      case "v":
        handlers.onToggleView?.()
        return true
    }
  }

  if (context === "viewer") {
    switch (key) {
      case "h":
      case "arrowleft":
        handlers.onPreviousSheet?.()
        return true
      case "l":
      case "arrowright":
        handlers.onNextSheet?.()
        return true
      case "+":
      case "=":
        handlers.onZoomIn?.()
        return true
      case "-":
        handlers.onZoomOut?.()
        return true
      case "0":
        handlers.onFitToScreen?.()
        return true
      case "1":
        handlers.onZoom100?.()
        return true
      case "m":
        handlers.onToggleMarkup?.()
        return true
      case "p":
        handlers.onTogglePins?.()
        return true
      case "d":
        handlers.onDownload?.()
        return true
      case "c":
        handlers.onToggleComparison?.()
        return true
    }
  }

  return false
}

/**
 * Keyboard shortcuts reference for list view
 */
export const LIST_SHORTCUTS = [
  { keys: ["j", "\u2193"], description: "Next sheet" },
  { keys: ["k", "\u2191"], description: "Previous sheet" },
  { keys: ["Enter"], description: "Open selected sheet" },
  { keys: ["/"], description: "Search sheets" },
  { keys: ["v"], description: "Toggle grid/list view" },
  { keys: ["g", "a"], description: "Filter: Architectural" },
  { keys: ["g", "s"], description: "Filter: Structural" },
  { keys: ["g", "m"], description: "Filter: Mechanical" },
  { keys: ["g", "e"], description: "Filter: Electrical" },
  { keys: ["g", "p"], description: "Filter: Plumbing" },
  { keys: ["g", "g"], description: "Clear filter (show all)" },
  { keys: ["Esc"], description: "Clear search" },
  { keys: ["?"], description: "Show this help" },
]

/**
 * Keyboard shortcuts reference for viewer
 */
export const VIEWER_SHORTCUTS = [
  { keys: ["h", "\u2190"], description: "Previous sheet" },
  { keys: ["l", "\u2192"], description: "Next sheet" },
  { keys: ["+"], description: "Zoom in" },
  { keys: ["-"], description: "Zoom out" },
  { keys: ["0"], description: "Fit to screen" },
  { keys: ["1"], description: "Zoom to 100%" },
  { keys: ["m"], description: "Toggle markup mode" },
  { keys: ["p"], description: "Toggle pins" },
  { keys: ["d"], description: "Download sheet" },
  { keys: ["c"], description: "Toggle comparison" },
  { keys: ["Esc"], description: "Close viewer" },
]
