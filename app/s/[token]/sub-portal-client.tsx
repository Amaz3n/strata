"use client"

import { useState, useCallback, useTransition, type ReactNode } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { LayoutDashboard, FileText, HelpCircle, ShieldCheck, MessageCircle } from "lucide-react"
import { ExternalPortalShell } from "@/components/portal/external-portal-shell"
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
    (complianceStatus?.missing.length ?? 0) +
    (complianceStatus?.expired.length ?? 0) +
    (complianceStatus?.deficiencies.length ?? 0)

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

  const tabs: Array<{ id: SubPortalTab; label: string; icon: typeof LayoutDashboard; indicator?: ReactNode }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "documents", label: "Documents", icon: FileText },
    {
      id: "rfis",
      label: "RFIs",
      icon: HelpCircle,
      indicator: data.pendingRfiCount > 0 ? <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" /> : null,
    },
    {
      id: "submittals",
      label: "Submittals",
      icon: FileText,
      indicator: data.pendingSubmittalCount > 0 ? <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" /> : null,
    },
    {
      id: "compliance",
      label: "Compliance",
      icon: ShieldCheck,
      indicator: complianceIssues > 0 ? <span className="ml-1.5 h-2 w-2 rounded-full bg-orange-500" /> : null,
    },
    { id: "messages", label: "Messages", icon: MessageCircle },
  ]

  const desktopTabs = tabs.filter((tab) => tab.id !== "messages")

  const renderTab = (tab: SubPortalTab) => {
    if (tab === "dashboard") {
      return (
        <SubDashboard
          data={data}
          token={token}
          canSubmitInvoices={canSubmitInvoices}
          complianceStatus={complianceStatus}
        />
      )
    }
    if (tab === "documents") {
      return <SubDocumentsTab files={data.sharedFiles} canDownload={canDownloadFiles} portalToken={token} />
    }
    if (tab === "rfis") return <SubRfisTab rfis={data.rfis} token={token} />
    if (tab === "submittals") return <SubSubmittalsTab submittals={data.submittals} token={token} />
    if (tab === "compliance") {
      return (
        <SubComplianceTab
          complianceStatus={complianceStatus}
          documentTypes={complianceDocumentTypes}
          token={token}
          canUpload={canUploadComplianceDocs}
          onRefresh={refreshCompliance}
        />
      )
    }
    return (
      <SubMessagesTab
        messages={data.messages}
        token={token}
        canMessage={canMessage}
        senderName={data.company.name}
      />
    )
  }

  return (
    <ExternalPortalShell
      orgName={data.org.name}
      project={data.project}
      isMobile={isMobile}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      desktopTabs={desktopTabs}
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
        <SubBottomNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          hasAttentionItems={hasAttentionItems}
          pendingRfis={data.pendingRfiCount}
          pendingSubmittals={data.pendingSubmittalCount}
          complianceIssues={complianceIssues}
        />
      }
    />
  )
}
