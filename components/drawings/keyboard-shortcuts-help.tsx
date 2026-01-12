"use client"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LIST_SHORTCUTS, VIEWER_SHORTCUTS } from "./use-drawing-keyboard-shortcuts"

interface KeyboardShortcutsHelpProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: "list" | "viewer"
}

export function KeyboardShortcutsHelp({
  open,
  onOpenChange,
  context,
}: KeyboardShortcutsHelpProps) {
  const shortcuts = context === "list" ? LIST_SHORTCUTS : VIEWER_SHORTCUTS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard Shortcuts</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2 max-h-[60vh] overflow-y-auto pr-2">
          {shortcuts.map((shortcut, i) => (
            <div
              key={i}
              className="flex items-center justify-between py-1"
            >
              <span className="text-sm text-muted-foreground">
                {shortcut.description}
              </span>
              <div className="flex gap-1">
                {shortcut.keys.map((key, j) => (
                  <span key={j} className="inline-flex items-center">
                    <kbd className="px-2 py-1 text-xs font-semibold bg-muted rounded border border-border">
                      {key}
                    </kbd>
                    {j < shortcut.keys.length - 1 && (
                      <span className="mx-1 text-xs text-muted-foreground">
                        {shortcut.keys.length === 2 && key.length === 1 && shortcut.keys[j + 1].length === 1
                          ? "then"
                          : "/"}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="pt-2 border-t text-xs text-muted-foreground">
          Press <kbd className="px-1.5 py-0.5 text-xs font-semibold bg-muted rounded border border-border">?</kbd> anytime to show this help
        </div>
      </DialogContent>
    </Dialog>
  )
}
