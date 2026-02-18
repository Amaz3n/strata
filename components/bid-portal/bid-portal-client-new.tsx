"use client"

import { useState, useMemo } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Home, FileText, Bell, Send, MessageSquare } from "lucide-react"
import { BidBottomNav, type BidPortalTab } from "@/components/bid-portal/bid-bottom-nav"
import { BidHomeTab } from "@/components/bid-portal/tabs/bid-home-tab"
import { BidDocumentsTab } from "@/components/bid-portal/tabs/bid-documents-tab"
import { BidAddendaTab } from "@/components/bid-portal/tabs/bid-addenda-tab"
import { BidSubmitTab } from "@/components/bid-portal/tabs/bid-submit-tab"
import { BidRfisTab } from "@/components/bid-portal/tabs/bid-rfis-tab"
import { BidPortalPinGate } from "@/components/bid-portal/bid-portal-pin-gate"
import { ExternalPortalShell } from "@/components/portal/external-portal-shell"
import type { BidPortalAccess, BidPortalData, BidPortalSubmission, BidPortalAddendum } from "@/lib/services/bid-portal"

interface BidPortalClientNewProps {
  token: string
  access: BidPortalAccess
  data: BidPortalData
  pinRequired?: boolean
}

export function BidPortalClientNew({ token, access, data, pinRequired = false }: BidPortalClientNewProps) {
  const [pinVerified, setPinVerified] = useState(!pinRequired)
  const [activeTab, setActiveTab] = useState<BidPortalTab>("home")
  const [currentSubmission, setCurrentSubmission] = useState<BidPortalSubmission | undefined>(data.currentSubmission)
  const [addenda, setAddenda] = useState<BidPortalAddendum[]>(data.addenda)
  const isMobile = useIsMobile()

  const unacknowledgedAddenda = useMemo(
    () => addenda.filter((a) => !a.acknowledged_at).length,
    [addenda]
  )

  const project = useMemo(
    () => ({
      id: access.project.id,
      name: access.project.name,
      status: access.project.status as "planning" | "bidding" | "active" | "on_hold" | "completed" | "cancelled",
      org_id: access.org_id,
      created_at: "",
      updated_at: "",
    }),
    [access.project, access.org_id]
  )

  const handleSubmissionChange = (submission: BidPortalSubmission) => {
    setCurrentSubmission(submission)
  }

  const handleAddendaChange = (updatedAddenda: BidPortalAddendum[]) => {
    setAddenda(updatedAddenda)
  }

  const tabs = [
    { id: "home" as const, label: "Home", icon: Home },
    { id: "documents" as const, label: "Files", icon: FileText },
    {
      id: "addenda" as const,
      label: "Addenda",
      icon: Bell,
      indicator: unacknowledgedAddenda > 0 ? <span className="ml-1 h-2 w-2 rounded-full bg-destructive" /> : null,
    },
    { id: "rfis" as const, label: "RFIs", icon: MessageSquare },
    {
      id: "submit" as const,
      label: "Submit",
      icon: Send,
      indicator: !currentSubmission ? <span className="ml-1 h-2 w-2 rounded-full bg-primary" /> : null,
    },
  ]

  const renderTab = (tab: BidPortalTab) => {
    if (tab === "home") return <BidHomeTab access={access} currentSubmission={currentSubmission} />
    if (tab === "documents") return <BidDocumentsTab files={data.packageFiles} />
    if (tab === "addenda") {
      return <BidAddendaTab addenda={addenda} token={token} onAddendaChange={handleAddendaChange} />
    }
    if (tab === "submit") {
      return (
        <BidSubmitTab
          token={token}
          access={access}
          currentSubmission={currentSubmission}
          submissions={data.submissions}
          onSubmissionChange={handleSubmissionChange}
        />
      )
    }
    return <BidRfisTab token={token} initialRfis={data.rfis} />
  }

  return (
    <ExternalPortalShell
      orgName={access.org.name}
      project={project}
      isMobile={isMobile}
      activeTab={activeTab}
      onTabChange={setActiveTab}
      tabs={tabs}
      renderTab={renderTab}
      pinVerified={pinVerified}
      pinGate={
        <BidPortalPinGate
          token={token}
          orgName={access.org.name}
          projectName={access.project.name}
          packageTitle={access.bidPackage.title}
          onSuccess={() => setPinVerified(true)}
        />
      }
      mobileNav={
        <BidBottomNav
          activeTab={activeTab}
          onTabChange={setActiveTab}
          unacknowledgedAddenda={unacknowledgedAddenda}
          hasSubmission={!!currentSubmission}
        />
      }
    />
  )
}
