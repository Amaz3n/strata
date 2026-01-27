"use client"

import { LayoutDashboard, FileText, HelpCircle, Package, MessageCircle, ShieldCheck } from "lucide-react"
import { cn } from "@/lib/utils"

export type SubPortalTab = "dashboard" | "documents" | "rfis" | "submittals" | "messages" | "compliance"

interface SubBottomNavProps {
  activeTab: SubPortalTab
  onTabChange: (tab: SubPortalTab) => void
  hasAttentionItems?: boolean
  pendingRfis?: number
  pendingSubmittals?: number
  complianceIssues?: number
}

const tabs: { id: SubPortalTab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "dashboard", label: "Home", icon: LayoutDashboard },
  { id: "documents", label: "Docs", icon: FileText },
  { id: "rfis", label: "RFIs", icon: HelpCircle },
  { id: "compliance", label: "Compliance", icon: ShieldCheck },
  { id: "messages", label: "Messages", icon: MessageCircle },
]

export function SubBottomNav({
  activeTab,
  onTabChange,
  pendingRfis = 0,
  pendingSubmittals = 0,
  complianceIssues = 0,
}: SubBottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          const showDot =
            (tab.id === "rfis" && pendingRfis > 0) ||
            (tab.id === "submittals" && pendingSubmittals > 0) ||
            (tab.id === "compliance" && complianceIssues > 0)

          return (
            <button
              key={tab.id}
              onClick={() => onTabChange(tab.id)}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 text-xs transition-colors",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
            >
              <div className="relative">
                <Icon className="h-5 w-5" />
                {showDot && (
                  <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-destructive" />
                )}
              </div>
              <span>{tab.label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
