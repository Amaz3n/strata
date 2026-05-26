"use client"

import { useState } from "react"
import { Download } from "lucide-react"

import { Button } from "@/components/ui/button"
import { QboImportSheet } from "@/components/integrations/qbo-import-sheet"

type Props = {
  projectId: string
  projectName?: string | null
  variant?: "default" | "outline" | "secondary" | "ghost"
  size?: "default" | "sm"
}

/** Opens the QuickBooks import sheet for the current project. */
export function QboImportLauncher({ projectId, projectName, variant = "outline", size = "sm" }: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)} className="gap-1.5">
        <Download className="size-4" />
        Import from QuickBooks
      </Button>
      <QboImportSheet open={open} onOpenChange={setOpen} projectId={projectId} projectName={projectName} />
    </>
  )
}
