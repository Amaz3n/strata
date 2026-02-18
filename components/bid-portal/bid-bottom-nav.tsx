"use client"

import { Home, FileText, Bell, Send, MessageSquare } from "lucide-react"
import { cn } from "@/lib/utils"

export type BidPortalTab = "home" | "documents" | "addenda" | "rfis" | "submit"

interface BidBottomNavProps {
  activeTab: BidPortalTab
  onTabChange: (tab: BidPortalTab) => void
  unacknowledgedAddenda?: number
  hasSubmission?: boolean
}

const tabs: { value: BidPortalTab; label: string; icon: typeof Home }[] = [
  { value: "home", label: "Home", icon: Home },
  { value: "documents", label: "Files", icon: FileText },
  { value: "addenda", label: "Addenda", icon: Bell },
  { value: "rfis", label: "RFIs", icon: MessageSquare },
  { value: "submit", label: "Submit", icon: Send },
]

export function BidBottomNav({
  activeTab,
  onTabChange,
  unacknowledgedAddenda = 0,
  hasSubmission = false,
}: BidBottomNavProps) {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-50 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="grid grid-cols-5 h-16">
        {tabs.map(({ value, label, icon: Icon }) => {
          const isActive = activeTab === value
          const showBadge = value === "addenda" && unacknowledgedAddenda > 0
          const showDot = value === "submit" && !hasSubmission

          return (
            <button
              key={value}
              type="button"
              onClick={() => onTabChange(value)}
              className={cn(
                "flex flex-col items-center justify-center gap-1 relative",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
                {showBadge && (
                  <span className="absolute -top-1 -right-1.5 h-4 min-w-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[10px] font-medium flex items-center justify-center">
                    {unacknowledgedAddenda}
                  </span>
                )}
                {showDot && (
                  <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-primary" />
                )}
              </div>
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
