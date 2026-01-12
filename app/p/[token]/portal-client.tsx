"use client"

import { useEffect, useMemo, useState } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Home, Camera, FileText, CheckSquare, MessageCircle, Info } from "lucide-react"
import { PortalHeader } from "@/components/portal/portal-header"
import { PortalBottomNav, type PortalTab } from "@/components/portal/portal-bottom-nav"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
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

  if (!pinVerified) {
    return (
      <PortalPinGate
        token={token}
        projectName={data.project.name}
        orgName={data.org.name}
        onSuccess={() => setPinVerified(true)}
      />
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <PortalHeader orgName={data.org.name} project={data.project} />

      {isMobile ? (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4 pb-20">
            {activeTab === "home" && <PortalHomeTab data={data} />}
            {activeTab === "timeline" && <PortalTimelineTab data={data} />}
            {activeTab === "documents" && <PortalDocumentsTab data={data} token={token} portalType={portalType} />}
            {activeTab === "actions" && <PortalActionsTab data={data} token={token} portalType={portalType} />}
            {activeTab === "messages" && (
              <PortalMessagesTab data={data} token={token} portalType={portalType} canMessage={canMessage} />
            )}
            {activeTab === "about" && <PortalAboutTab data={data} />}
          </main>
          <PortalBottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            hasPendingActions={hasPendingActions}
            tabs={tabsForPortal}
          />
        </>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-4xl px-6 py-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as PortalTab)}>
            <TabsList className="w-full justify-start mb-6 h-11">
              <TabsTrigger value="home" className="gap-2">
                <Home className="h-4 w-4" />
                Home
              </TabsTrigger>
              <TabsTrigger value="timeline" className="gap-2">
                <Camera className="h-4 w-4" />
                Timeline
              </TabsTrigger>
              <TabsTrigger value="documents" className="gap-2">
                <FileText className="h-4 w-4" />
                Documents
              </TabsTrigger>
              <TabsTrigger value="actions" className="gap-2 relative">
                <CheckSquare className="h-4 w-4" />
                Actions
                {hasPendingActions && (
                  <span className="ml-1 h-2 w-2 rounded-full bg-destructive" />
                )}
              </TabsTrigger>
              {canMessage && (
                <TabsTrigger value="messages" className="gap-2">
                  <MessageCircle className="h-4 w-4" />
                  Messages
                </TabsTrigger>
              )}
              <TabsTrigger value="about" className="gap-2">
                <Info className="h-4 w-4" />
                About
              </TabsTrigger>
            </TabsList>
            <TabsContent value="home"><PortalHomeTab data={data} /></TabsContent>
            <TabsContent value="timeline"><PortalTimelineTab data={data} /></TabsContent>
            <TabsContent value="documents"><PortalDocumentsTab data={data} token={token} portalType={portalType} /></TabsContent>
            <TabsContent value="actions"><PortalActionsTab data={data} token={token} portalType={portalType} /></TabsContent>
            {canMessage && (
              <TabsContent value="messages">
                <PortalMessagesTab data={data} token={token} portalType={portalType} canMessage={canMessage} />
              </TabsContent>
            )}
            <TabsContent value="about"><PortalAboutTab data={data} /></TabsContent>
          </Tabs>
        </main>
      )}
    </div>
  )
}
