"use client"

import { motion } from "framer-motion"
import { Download, Loader2, Send, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * What you can do to the rows you ticked. Each action names how many of the
 * selection it applies to, and is absent when it applies to none — a bar of
 * greyed-out verbs is a bar nobody reads.
 */
export interface InvoiceBulkActions {
  sendable: number
  remindable: number
  voidable: number
  deletable: number
}

export function InvoiceBottomBar({
  selectedCount,
  totalCents,
  actions,
  busy,
  onDeselectAll,
  onSend,
  onRemind,
  onVoid,
  onDelete,
  onExportCsv,
}: {
  selectedCount: number
  totalCents: number
  actions: InvoiceBulkActions
  busy: string | null
  onDeselectAll: () => void
  onSend: () => void
  onRemind: () => void
  onVoid: () => void
  onDelete: () => void
  onExportCsv: () => void
}) {
  const money = (totalCents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
  return (
    <motion.div
      className="pointer-events-none fixed bottom-4 left-0 right-0 z-50 flex justify-center"
      initial={{ y: 40, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 40, opacity: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 30 }}
    >
      <div className="pointer-events-auto flex h-11 items-center gap-1 border bg-background/90 pl-4 pr-2 shadow-lg backdrop-blur">
        <span className="mr-2 text-sm">
          <span className="font-medium tabular-nums">{selectedCount}</span>
          <span className="text-muted-foreground"> selected</span>
          <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">{money}</span>
        </span>
        <span className="mx-1 h-5 w-px bg-border" />
        {actions.sendable > 0 ? (
          <Button size="sm" className="h-8" onClick={onSend} disabled={busy !== null}>
            {busy === "send" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
            Send {actions.sendable}
          </Button>
        ) : null}
        {actions.remindable > 0 ? (
          <Button size="sm" variant={actions.sendable > 0 ? "outline" : "default"} className="h-8" onClick={onRemind} disabled={busy !== null}>
            {busy === "remind" ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            Remind {actions.remindable}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="h-8" onClick={onExportCsv} disabled={busy !== null}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          CSV
        </Button>
        {actions.voidable > 0 ? (
          <Button size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive" onClick={onVoid} disabled={busy !== null}>
            Void {actions.voidable}
          </Button>
        ) : null}
        {actions.deletable > 0 ? (
          <Button size="sm" variant="ghost" className="h-8 text-destructive hover:text-destructive" onClick={onDelete} disabled={busy !== null}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete {actions.deletable}
          </Button>
        ) : null}
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="sm" variant="ghost" className="h-8 text-muted-foreground" onClick={onDeselectAll} disabled={busy !== null}>
          Clear
        </Button>
      </div>
    </motion.div>
  )
}
