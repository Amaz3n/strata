"use client"

import { useState, useCallback, useTransition, type ReactNode } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import Link from "next/link"
import { LayoutDashboard, FileText, HelpCircle, ShieldCheck, CheckSquare, ClipboardCheck, ClipboardList, ShoppingCart } from "lucide-react"
import { ExternalPortalShell } from "@/components/portal/external-portal-shell"
import {
  SubBottomNav,
  SubComplianceTab,
  SubDashboard,
  SubDocumentsTab,
  type SubPortalTab,
} from "@/components/portal/sub"
import { SubPunchTab } from "./sub-punch-tab"
import { SubRfisTab } from "./sub-rfis-tab"
import { SubSubmittalsTab } from "./sub-submittals-tab"
import { SubPrequalificationTab } from "./sub-prequalification-tab"
import { SubDailyLogsTab } from "./sub-daily-logs-tab"
import type { Prequalification } from "@/lib/services/prequalification"
import type { WarrantyServiceVisitDTO } from "@/lib/services/warranty"
import { SubWarrantyVisits } from "./sub-warranty-visits"
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
  canSubmitDailyLogs?: boolean
  canDownloadFiles?: boolean
  canUploadComplianceDocs?: boolean
  canUploadSubtierWaivers?: boolean
  canWorkPunchItems?: boolean
  canViewPurchaseOrders?: boolean
  pinRequired?: boolean
  complianceDocumentTypes?: ComplianceDocumentType[]
  workspace?: ExternalPortalWorkspaceContext | null
  inviteEmail?: string
  suggestedFullName?: string
  prequalification?: Prequalification | null
  warrantyVisits?: Array<WarrantyServiceVisitDTO & { request?: Record<string, unknown> | null; project?: Record<string, unknown> | null }>
}

export function SubPortalClient({
  data: initialData,
  token,
  canSubmitInvoices = true,
  canSubmitTime = true,
  canSubmitExpenses = true,
  canSubmitDailyLogs = false,
  canDownloadFiles = true,
  canUploadComplianceDocs = true,
  canUploadSubtierWaivers = true,
  canWorkPunchItems = false,
  canViewPurchaseOrders = false,
  pinRequired = false,
  complianceDocumentTypes = [],
  workspace = null,
  inviteEmail = "",
  suggestedFullName = "",
  prequalification = null,
  warrantyVisits = [],
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
    ...(canViewPurchaseOrders ? [{ id: "purchase-orders" as const, label: "Purchase orders", icon: ShoppingCart }] : []),
    ...(canSubmitDailyLogs ? [{ id: "daily-logs" as const, label: "Daily logs", icon: ClipboardList }] : []),
    {
      id: "prequalification",
      label: "Prequalification",
      icon: ClipboardCheck,
      indicator: prequalification?.status === "requested" ? <span className="ml-1.5 h-2 w-2 rounded-full bg-warning" /> : null,
    },
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
    ...(canWorkPunchItems
      ? [
          {
            id: "punch" as const,
            label: "Punch",
            icon: CheckSquare,
            indicator:
              data.pendingPunchCount > 0 ? (
                <span className="ml-1.5 h-2 w-2 rounded-full bg-destructive" />
              ) : null,
          },
        ]
      : []),
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
        <>
          <SubWarrantyVisits token={token} initialVisits={warrantyVisits} />
          <SubDashboard
            data={data}
            token={token}
            canSubmitInvoices={canSubmitInvoices}
            canSubmitTime={canSubmitTime}
            canSubmitExpenses={canSubmitExpenses}
            complianceStatus={complianceStatus}
            canUploadSubtierWaivers={canUploadSubtierWaivers}
          />
        </>
      )
    }
    if (tab === "documents") {
      return <SubDocumentsTab files={data.sharedFiles} canDownload={canDownloadFiles} portalToken={token} />
    }
    if (tab === "purchase-orders") {
      return <div className="mx-auto max-w-xl p-4"><div className="border p-5"><ShoppingCart className="mb-3 size-5 text-muted-foreground" /><h2 className="font-semibold">Purchase orders</h2><p className="mt-1 text-sm text-muted-foreground">Review awarded work, approved variances, completion, billing, and payment status.</p><Link className="mt-4 inline-flex h-9 items-center border border-input px-3 text-sm font-medium" href={`/s/${token}/purchase-orders`}>Open purchase orders</Link></div></div>
    }
    if (tab === "daily-logs") return <SubDailyLogsTab token={token} />
    if (tab === "rfis") return <SubRfisTab rfis={data.rfis} token={token} />
    if (tab === "submittals") return <SubSubmittalsTab submittals={data.submittals} token={token} />
    if (tab === "punch") return <SubPunchTab punchItems={data.punchItems} token={token} />
    if (tab === "prequalification") return <SubPrequalificationTab token={token} initial={prequalification} />
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
          pendingPunch={data.pendingPunchCount}
          showPunch={canWorkPunchItems}
          showDailyLogs={canSubmitDailyLogs}
          showPurchaseOrders={canViewPurchaseOrders}
          complianceIssues={complianceIssues}
        />
      }
    />
  )
}
