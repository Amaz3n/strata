"use client"

import { useEffect, type ReactNode } from "react"
import { type LucideIcon } from "lucide-react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PortalHeader } from "@/components/portal/portal-header"
import type { Project } from "@/lib/types"

export interface ExternalPortalTab<TTab extends string> {
  id: TTab
  label: string
  icon?: LucideIcon
  indicator?: ReactNode
}

interface ExternalPortalShellProps<TTab extends string> {
  orgName: string
  project: Project
  isMobile: boolean
  activeTab: TTab
  onTabChange: (tab: TTab) => void
  tabs: ExternalPortalTab<TTab>[]
  desktopTabs?: ExternalPortalTab<TTab>[]
  renderTab: (tab: TTab) => ReactNode
  mobileNav: ReactNode
  pinVerified?: boolean
  pinGate?: ReactNode
}

export function ExternalPortalShell<TTab extends string>({
  orgName,
  project,
  isMobile,
  activeTab,
  onTabChange,
  tabs,
  desktopTabs,
  renderTab,
  mobileNav,
  pinVerified = true,
  pinGate = null,
}: ExternalPortalShellProps<TTab>) {
  const resolvedDesktopTabs = desktopTabs ?? tabs
  const visibleTabIds = (isMobile ? tabs : resolvedDesktopTabs).map((tab) => tab.id)

  useEffect(() => {
    if (!visibleTabIds.includes(activeTab)) {
      onTabChange(visibleTabIds[0])
    }
  }, [activeTab, onTabChange, visibleTabIds])

  if (!pinVerified) {
    return <>{pinGate}</>
  }

  return (
    <div className="min-h-screen flex flex-col bg-background font-sans">
      <PortalHeader orgName={orgName} project={project} />

      {isMobile ? (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4 pb-20">{renderTab(activeTab)}</main>
          {mobileNav}
        </>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-4xl px-6 py-6">
          <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as TTab)}>
            <TabsList className="w-full justify-start mb-6 h-11">
              {resolvedDesktopTabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <TabsTrigger key={tab.id} value={tab.id} className="gap-2 relative">
                    {Icon ? <Icon className="h-4 w-4" /> : null}
                    {tab.label}
                    {tab.indicator}
                  </TabsTrigger>
                )
              })}
            </TabsList>
            {resolvedDesktopTabs.map((tab) => (
              <TabsContent key={tab.id} value={tab.id}>
                {renderTab(tab.id)}
              </TabsContent>
            ))}
          </Tabs>
        </main>
      )}
    </div>
  )
}
