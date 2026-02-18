"use client"

import { SettingsWindow } from "@/components/settings/settings-window"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { QBOConnection } from "@/lib/services/qbo-connection"
import type { User } from "@/lib/types"

interface SettingsDialogProps {
  user: User | null
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: string
  initialQboConnection?: QBOConnection | null
}

export function SettingsDialog({
  user,
  open,
  onOpenChange,
  initialTab,
  initialQboConnection = null,
}: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(1500px,95vw)] max-w-none overflow-hidden border border-border/80 bg-background/95 p-0 shadow-[0_28px_80px_-46px_rgba(15,23,42,0.45)] backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:max-w-none"
        showCloseButton
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <SettingsWindow
          user={user}
          initialTab={initialTab}
          initialQboConnection={initialQboConnection}
          variant="dialog"
        />
      </DialogContent>
    </Dialog>
  )
}
