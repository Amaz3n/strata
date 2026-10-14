"use client"

import { useState } from "react"

import { PostCutoffChangeDialog } from "@/components/design-studio/post-cutoff-change-dialog"
import type { SheetGroup } from "@/lib/services/design-studio"

/**
 * Opens the selection change order for a choice the home can no longer take
 * directly, prefilled with that selection. Closing it drops `?selection=` so a
 * refresh does not reopen it.
 */
export function SelectionChangeOrderPrompt({
  projectId,
  group,
  selectionId,
  changeFeeCents,
  canWaiveChangeFee,
}: {
  projectId: string
  group: SheetGroup
  selectionId: string
  changeFeeCents: number
  canWaiveChangeFee: boolean
}) {
  const [open, setOpen] = useState(true)
  return (
    <PostCutoffChangeDialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          const url = new URL(window.location.href)
          url.searchParams.delete("selection")
          window.history.replaceState(null, "", url)
        }
      }}
      projectId={projectId}
      group={group}
      initial={{ selectionId }}
      changeFeeCents={changeFeeCents}
      canWaiveChangeFee={canWaiveChangeFee}
    />
  )
}
