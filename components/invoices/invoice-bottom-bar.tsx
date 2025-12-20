"use client"

import { Button } from "@/components/ui/button"
import { motion } from "framer-motion"

interface InvoiceBottomBarProps {
  selectedCount: number
  onDeselectAll: () => void
  // Add more bulk actions here as needed
}

export function InvoiceBottomBar({ selectedCount, onDeselectAll }: InvoiceBottomBarProps) {
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
          <Button variant="ghost" onClick={onDeselectAll}>
            <span>Deselect all</span>
          </Button>

          {/* Add more bulk actions here as needed */}
          {/* <Button variant="default">
            <span>Bulk action</span>
          </Button> */}
        </div>
      </div>
    </motion.div>
  )
}
