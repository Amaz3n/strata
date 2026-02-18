"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Home, Camera, FileText, CheckSquare, MessageCircle, Info } from "lucide-react"
import { PortalBottomNav, type PortalTab } from "@/components/portal/portal-bottom-nav"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { ExternalPortalShell } from "@/components/portal/external-portal-shell"
import { PortalHomeTab } from "@/components/portal/tabs/portal-home-tab"
import { PortalTimelineTab } from "@/components/portal/tabs/portal-timeline-tab"
import { PortalDocumentsTab } from "@/components/portal/tabs/portal-documents-tab"
import { PortalActionsTab } from "@/components/portal/tabs/portal-actions-tab"
import { PortalMessagesTab } from "@/components/portal/tabs/portal-messages-tab"
import { PortalAboutTab } from "@/components/portal/tabs/portal-about-tab"
import type { ClientPortalData } from "@/lib/types"

interface PortalPublicClientProps {
  data: ClientPortalData
  token: string
  portalType?: "client" | "sub"
  pinRequired?: boolean
  canMessage?: boolean
}

export function PortalPublicClient({
  data,
  token,
  portalType = "client",
  pinRequired = false,
  canMessage = false,
}: PortalPublicClientProps) {
  const [activeTab, setActiveTab] = useState<PortalTab>("home")
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const isMobile = useIsMobile()

  const tabsForPortal = useMemo<PortalTab[]>(
    () => (canMessage ? ["home", "timeline", "documents", "actions", "messages", "about"] : ["home", "timeline", "documents", "actions", "about"]),
    [canMessage],
  )

  const hasPendingActions = data.pendingChangeOrders.length > 0 || data.pendingSelections.length > 0

  useEffect(() => {
    if (!tabsForPortal.includes(activeTab)) {
      setActiveTab("home")
    }
  }, [activeTab, tabsForPortal])

  const shellTabs = useMemo(
    () =>
      [
        { id: "home", label: "Home", icon: Home },
        { id: "timeline", label: "Timeline", icon: Camera },
        { id: "documents", label: "Documents", icon: FileText },
        {
          id: "actions",
          label: "Actions",
          icon: CheckSquare,
          indicator: hasPendingActions ? <span className="ml-1 h-2 w-2 rounded-full bg-destructive" /> : null,
        },
        canMessage ? { id: "messages", label: "Messages", icon: MessageCircle } : null,
        { id: "about", label: "About", icon: Info },
      ].filter(Boolean) as Array<{ id: PortalTab; label: string; icon: typeof Home; indicator?: ReactNode }>,
    [canMessage, hasPendingActions],
  )

  const renderTab = (tab: PortalTab) => {
    if (tab === "home") return <PortalHomeTab data={data} />
    if (tab === "timeline") return <PortalTimelineTab data={data} />
    if (tab === "documents") return <PortalDocumentsTab data={data} token={token} portalType={portalType} />
    if (tab === "actions") return <PortalActionsTab data={data} token={token} portalType={portalType} />
    if (tab === "messages") {
      return <PortalMessagesTab data={data} token={token} portalType={portalType} canMessage={canMessage} />
    }
    return <PortalAboutTab data={data} />
  }

  return (
    <ExternalPortalShell
      orgName={data.org.name}
      project={data.project}
      isMobile={isMobile}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={shellTabs}
      renderTab={renderTab}
      pinVerified={pinVerified}
      pinGate={
        <PortalPinGate
          token={token}
          projectName={data.project.name}
          orgName={data.org.name}
          onSuccess={() => setPinVerified(true)}
        />
      }
      mobileNav={
        <PortalBottomNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          hasPendingActions={hasPendingActions}
          tabs={tabsForPortal}
        />
      }
    />
  )
}
