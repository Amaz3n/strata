"use client"

import { useState, useCallback, useTransition, type ReactNode } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { LayoutDashboard, FileText, HelpCircle, ShieldCheck } from "lucide-react"
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
import type {
  ComplianceDocumentType,
  ComplianceStatusSummary,
  ExternalPortalWorkspaceContext,
  SubPortalData,
} from "@/lib/types"

interface SubPortalClientProps {
  data: SubPortalData
  token: string
  canSubmitInvoices?: boolean
  canSubmitTime?: boolean
  canSubmitExpenses?: boolean
  canDownloadFiles?: boolean
  canUploadComplianceDocs?: boolean
  pinRequired?: boolean
  complianceDocumentTypes?: ComplianceDocumentType[]
  workspace?: ExternalPortalWorkspaceContext | null
  inviteEmail?: string
  suggestedFullName?: string
}

export function SubPortalClient({
  data: initialData,
  token,
  canSubmitInvoices = true,
  canSubmitTime = true,
  canSubmitExpenses = true,
  canDownloadFiles = true,
  canUploadComplianceDocs = true,
  pinRequired = false,
  complianceDocumentTypes = [],
  workspace = null,
  inviteEmail = "",
  suggestedFullName = "",
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
  ]

  const desktopTabs = tabs

  const renderTab = (tab: SubPortalTab) => {
    if (tab === "dashboard") {
      return (
        <SubDashboard
          data={data}
          token={token}
          canSubmitInvoices={canSubmitInvoices}
          canSubmitTime={canSubmitTime}
          canSubmitExpenses={canSubmitExpenses}
          complianceStatus={complianceStatus}
        />
      )
    }
    if (tab === "documents") {
      return <SubDocumentsTab files={data.sharedFiles} canDownload={canDownloadFiles} portalToken={token} />
    }
    if (tab === "rfis") return <SubRfisTab rfis={data.rfis} token={token} />
    if (tab === "submittals") return <SubSubmittalsTab submittals={data.submittals} token={token} />
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
    <ExternalPortalShell
      orgName={data.org.name}
      project={data.project}
      workspace={workspace}
      logoUrl={data.org.logo_url}
      isMobile={isMobile}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      desktopTabs={desktopTabs}
      renderTab={renderTab}
      pinVerified={pinVerified}
      token={token}
      tokenType="portal"
      email={inviteEmail}
      suggestedFullName={suggestedFullName}
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
