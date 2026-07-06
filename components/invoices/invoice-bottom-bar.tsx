"use client"

import { Button } from "@/components/ui/button"
import { motion } from "framer-motion"
import { Download, Send } from "lucide-react"

interface InvoiceBottomBarProps {
  selectedCount: number
  onDeselectAll: () => void
  onExportCsv?: () => void
  onSendReminders?: () => void
  reminderEligibleCount?: number
  sendingReminders?: boolean
}

export function InvoiceBottomBar({
  selectedCount,
  onDeselectAll,
  onExportCsv,
  onSendReminders,
  reminderEligibleCount = 0,
  sendingReminders = false,
}: InvoiceBottomBarProps) {
  return (
    <motion.div
      className="h-12 fixed bottom-4 left-0 right-0 pointer-events-none flex justify-center z-50"
      initial={{ y: 100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 100, opacity: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
    >
      <div className="pointer-events-auto backdrop-filter min-w-[400px] backdrop-blur-lg dark:bg-[#1A1A1A]/80 bg-[#F6F6F3]/80 h-12 justify-between items-center flex px-4 border dark:border-[#2C2C2C] border-[#DCDAD2] rounded-lg">
        <span className="text-sm text-[#878787]">
          {selectedCount} selected
        </span>

        <div className="flex items-center space-x-2">
          <Button variant="ghost" size="sm" onClick={onDeselectAll}>
            <span>Deselect all</span>
          </Button>

          {onExportCsv && (
            <Button variant="outline" size="sm" onClick={onExportCsv}>
              <Download className="mr-1.5 h-4 w-4" />
              Export CSV
            </Button>
          )}

          {onSendReminders && (
            <Button
              variant="default"
              size="sm"
              onClick={onSendReminders}
              disabled={sendingReminders || reminderEligibleCount === 0}
              title={reminderEligibleCount === 0 ? "No selected invoices are open and sent" : undefined}
            >
              <Send className="mr-1.5 h-4 w-4" />
              {sendingReminders
                ? "Sending…"
                : `Send reminders${reminderEligibleCount > 0 ? ` (${reminderEligibleCount})` : ""}`}
            </Button>
          )}
        </div>
      </div>
    </motion.div>
  )
}
