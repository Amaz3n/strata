"use client"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { WORKSPACE_SHORTCUTS } from "./workspace/workspace-tools"

export function KeyboardShortcutsHelp({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="grid max-h-[60vh] gap-x-6 gap-y-1.5 overflow-y-auto text-sm sm:grid-cols-2">
          {WORKSPACE_SHORTCUTS.map((shortcut) => (
            <div key={shortcut.description} className="flex items-center justify-between gap-3 border-b py-1.5">
              <dt className="text-muted-foreground">{shortcut.description}</dt>
              <dd className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <kbd key={key} className="border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold">
                    {key}
                  </kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
