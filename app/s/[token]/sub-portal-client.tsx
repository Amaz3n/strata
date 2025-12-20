"use client"

import { useState } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PortalHeader } from "@/components/portal/portal-header"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import {
  SubBottomNav,
  SubDashboard,
  SubDocumentsTab,
  type SubPortalTab,
} from "@/components/portal/sub"
import { SubRfisTab } from "./sub-rfis-tab"
import { SubSubmittalsTab } from "./sub-submittals-tab"
import { SubMessagesTab } from "./sub-messages-tab"
import type { SubPortalData } from "@/lib/types"

interface SubPortalClientProps {
  data: SubPortalData
  token: string
  canMessage?: boolean
  canSubmitInvoices?: boolean
  canDownloadFiles?: boolean
  pinRequired?: boolean
}

export function SubPortalClient({
  data,
  token,
  canMessage = false,
  canSubmitInvoices = true,
  canDownloadFiles = true,
  pinRequired = false,
}: SubPortalClientProps) {
  const [activeTab, setActiveTab] = useState<SubPortalTab>("dashboard")
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const isMobile = useIsMobile()

  const hasAttentionItems = data.pendingRfiCount > 0 || data.pendingSubmittalCount > 0

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
    <div className="min-h-screen flex flex-col bg-background">
      <PortalHeader orgName={data.org.name} project={data.project} />

      {isMobile ? (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4 pb-20">
            {activeTab === "dashboard" && (
              <SubDashboard
                data={data}
                token={token}
                canSubmitInvoices={canSubmitInvoices}
              />
            )}
            {activeTab === "documents" && (
              <SubDocumentsTab
                files={data.sharedFiles}
                canDownload={canDownloadFiles}
              />
            )}
            {activeTab === "rfis" && (
              <SubRfisTab rfis={data.rfis} token={token} />
            )}
            {activeTab === "submittals" && (
              <SubSubmittalsTab submittals={data.submittals} token={token} />
            )}
            {activeTab === "messages" && (
              <SubMessagesTab
                messages={data.messages}
                token={token}
                canMessage={canMessage}
                projectId={data.project.id}
                companyId={data.company.id}
              />
            )}
          </main>
          <SubBottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            hasAttentionItems={hasAttentionItems}
            pendingRfis={data.pendingRfiCount}
            pendingSubmittals={data.pendingSubmittalCount}
          />
        </>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-4xl px-4 py-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as SubPortalTab)}>
            <TabsList className="w-full justify-start mb-4">
              <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="rfis" className="relative">
                RFIs
                {data.pendingRfiCount > 0 && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" />
                )}
              </TabsTrigger>
              <TabsTrigger value="submittals" className="relative">
                Submittals
                {data.pendingSubmittalCount > 0 && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" />
                )}
              </TabsTrigger>
              <TabsTrigger value="messages">Messages</TabsTrigger>
            </TabsList>
            <TabsContent value="dashboard">
              <SubDashboard
                data={data}
                token={token}
                canSubmitInvoices={canSubmitInvoices}
              />
            </TabsContent>
            <TabsContent value="documents">
              <SubDocumentsTab
                files={data.sharedFiles}
                canDownload={canDownloadFiles}
              />
            </TabsContent>
            <TabsContent value="rfis">
              <SubRfisTab rfis={data.rfis} token={token} />
            </TabsContent>
            <TabsContent value="submittals">
              <SubSubmittalsTab submittals={data.submittals} token={token} />
            </TabsContent>
            <TabsContent value="messages">
              <SubMessagesTab
                messages={data.messages}
                token={token}
                canMessage={canMessage}
                projectId={data.project.id}
                companyId={data.company.id}
              />
            </TabsContent>
          </Tabs>
        </main>
      )}
    </div>
  )
}
