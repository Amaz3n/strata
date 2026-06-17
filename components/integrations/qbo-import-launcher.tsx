"use client"

import { useState } from "react"
import { Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import { QboSyncSheet } from "@/components/integrations/qbo-sync-sheet"

type Props = {
  projectId: string
  projectName?: string | null
  variant?: "default" | "outline" | "secondary" | "ghost"
  size?: "default" | "sm"
}

/** Opens the QuickBooks sheet straight to its Import tab (which widens for the import grid). */
export function QboImportLauncher({ projectId, projectName, variant = "outline", size = "sm" }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} className="gap-1.5">
        <Download className="size-4" />
        Import from QuickBooks
      </Button>
      <QboSyncSheet open={open} onOpenChange={setOpen} projectId={projectId} projectName={projectName} initialTab="import" />
    </>
  )
}
