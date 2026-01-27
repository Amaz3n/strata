"use client"

import { useState, useCallback, useTransition } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PortalHeader } from "@/components/portal/portal-header"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import {
  SubBottomNav,
  SubComplianceTab,
  SubDashboard,
  SubDocumentsTab,
  type SubPortalTab,
} from "@/components/portal/sub"
import { SubRfisTab } from "./sub-rfis-tab"
import { SubSubmittalsTab } from "./sub-submittals-tab"
import { SubMessagesTab } from "./sub-messages-tab"
import type { ComplianceDocumentType, ComplianceStatusSummary, SubPortalData } from "@/lib/types"

interface SubPortalClientProps {
  data: SubPortalData
  token: string
  canMessage?: boolean
  canSubmitInvoices?: boolean
  canDownloadFiles?: boolean
  canUploadComplianceDocs?: boolean
  pinRequired?: boolean
  complianceDocumentTypes?: ComplianceDocumentType[]
}

export function SubPortalClient({
  data: initialData,
  token,
  canMessage = false,
  canSubmitInvoices = true,
  canDownloadFiles = true,
  canUploadComplianceDocs = true,
  pinRequired = false,
  complianceDocumentTypes = [],
}: SubPortalClientProps) {
  const [activeTab, setActiveTab] = useState<SubPortalTab>("dashboard")
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const [data, setData] = useState(initialData)
  const [complianceStatus, setComplianceStatus] = useState<ComplianceStatusSummary | undefined>(
    initialData.complianceStatus
  )
  const [, startTransition] = useTransition()
  const isMobile = useIsMobile()

  const hasAttentionItems = data.pendingRfiCount > 0 || data.pendingSubmittalCount > 0
  const complianceIssues =
    (complianceStatus?.missing.length ?? 0) + (complianceStatus?.expired.length ?? 0)

  const refreshCompliance = useCallback(() => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/portal/s/${token}/compliance`)
        if (res.ok) {
          const status = await res.json()
          setComplianceStatus(status)
        }
      } catch {
        // Silently fail - user can refresh manually
      }
    })
  }, [token])

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
                portalToken={token}
              />
            )}
            {activeTab === "rfis" && (
              <SubRfisTab rfis={data.rfis} token={token} />
            )}
            {activeTab === "submittals" && (
              <SubSubmittalsTab submittals={data.submittals} token={token} />
            )}
            {activeTab === "compliance" && (
              <SubComplianceTab
                complianceStatus={complianceStatus}
                documentTypes={complianceDocumentTypes}
                token={token}
                canUpload={canUploadComplianceDocs}
                onRefresh={refreshCompliance}
              />
            )}
            {activeTab === "messages" && (
              <SubMessagesTab
                messages={data.messages}
                token={token}
                canMessage={canMessage}
                senderName={data.company.name}
              />
            )}
          </main>
          <SubBottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            hasAttentionItems={hasAttentionItems}
            pendingRfis={data.pendingRfiCount}
            pendingSubmittals={data.pendingSubmittalCount}
            complianceIssues={complianceIssues}
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
              <TabsTrigger value="compliance" className="relative">
                Compliance
                {complianceIssues > 0 && (
                  <span className="ml-1.5 h-2 w-2 rounded-full bg-orange-500" />
                )}
              </TabsTrigger>
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
                portalToken={token}
              />
            </TabsContent>
            <TabsContent value="rfis">
              <SubRfisTab rfis={data.rfis} token={token} />
            </TabsContent>
            <TabsContent value="submittals">
              <SubSubmittalsTab submittals={data.submittals} token={token} />
            </TabsContent>
            <TabsContent value="compliance">
              <SubComplianceTab
                complianceStatus={complianceStatus}
                documentTypes={complianceDocumentTypes}
                token={token}
                canUpload={canUploadComplianceDocs}
                onRefresh={refreshCompliance}
              />
            </TabsContent>
          </Tabs>
        </main>
      )}
    </div>
  )
}
