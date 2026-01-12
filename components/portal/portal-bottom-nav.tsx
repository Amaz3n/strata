"use client"

import { Home, Camera, FileText, CheckSquare, MessageCircle, Info } from "lucide-react"
import { cn } from "@/lib/utils"

export type PortalTab = "home" | "timeline" | "documents" | "actions" | "messages" | "about"

interface PortalBottomNavProps {
  activeTab: PortalTab
  onTabChange: (tab: PortalTab) => void
  hasPendingActions?: boolean
  tabs?: PortalTab[]
}

const tabs: { id: PortalTab; label: string; icon: typeof Home }[] = [
  { id: "home", label: "Home", icon: Home },
  { id: "timeline", label: "Timeline", icon: Camera },
  { id: "documents", label: "Docs", icon: FileText },
  { id: "actions", label: "Actions", icon: CheckSquare },
  { id: "messages", label: "Messages", icon: MessageCircle },
  { id: "about", label: "About", icon: Info },
]

export function PortalBottomNav({ activeTab, onTabChange, hasPendingActions, tabs: visibleTabs }: PortalBottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <div className="flex h-14">
        {(visibleTabs ? tabs.filter((t) => visibleTabs.includes(t.id)) : tabs).map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          const showDot = tab.id === "actions" && hasPendingActions

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
