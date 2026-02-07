"use client"

import { useState, useMemo } from "react"
import { useIsMobile } from "@/components/ui/use-mobile"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Home, FileText, Bell, Send } from "lucide-react"
import { PortalHeader } from "@/components/portal/portal-header"
import { BidBottomNav, type BidPortalTab } from "@/components/bid-portal/bid-bottom-nav"
import { BidHomeTab } from "@/components/bid-portal/tabs/bid-home-tab"
import { BidDocumentsTab } from "@/components/bid-portal/tabs/bid-documents-tab"
import { BidAddendaTab } from "@/components/bid-portal/tabs/bid-addenda-tab"
import { BidSubmitTab } from "@/components/bid-portal/tabs/bid-submit-tab"
import { BidPortalPinGate } from "@/components/bid-portal/bid-portal-pin-gate"
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
    }),
    [access.project, access.org_id]
  )

  const handleSubmissionChange = (submission: BidPortalSubmission) => {
    setCurrentSubmission(submission)
  }

  const handleAddendaChange = (updatedAddenda: BidPortalAddendum[]) => {
    setAddenda(updatedAddenda)
  }

  if (!pinVerified) {
    return (
      <BidPortalPinGate
        token={token}
        orgName={access.org.name}
        projectName={access.project.name}
        packageTitle={access.bidPackage.title}
        onSuccess={() => setPinVerified(true)}
      />
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PortalHeader orgName={access.org.name} project={project} />

      {isMobile ? (
        <>
          <main className="flex-1 overflow-y-auto px-3 py-4 pb-20">
            {activeTab === "home" && (
              <BidHomeTab access={access} currentSubmission={currentSubmission} />
            )}
            {activeTab === "documents" && (
              <BidDocumentsTab files={data.packageFiles} />
            )}
            {activeTab === "addenda" && (
              <BidAddendaTab
                addenda={addenda}
                token={token}
                onAddendaChange={handleAddendaChange}
              />
            )}
            {activeTab === "submit" && (
              <BidSubmitTab
                token={token}
                access={access}
                currentSubmission={currentSubmission}
                submissions={data.submissions}
                onSubmissionChange={handleSubmissionChange}
              />
            )}
          </main>
          <BidBottomNav
            activeTab={activeTab}
            onTabChange={setActiveTab}
            unacknowledgedAddenda={unacknowledgedAddenda}
            hasSubmission={!!currentSubmission}
          />
        </>
      ) : (
        <main className="flex-1 mx-auto w-full max-w-4xl px-6 py-6">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as BidPortalTab)}>
            <TabsList className="w-full justify-start mb-6 h-11">
              <TabsTrigger value="home" className="gap-2">
                <Home className="h-4 w-4" />
                Home
              </TabsTrigger>
              <TabsTrigger value="documents" className="gap-2">
                <FileText className="h-4 w-4" />
                Files
              </TabsTrigger>
              <TabsTrigger value="addenda" className="gap-2 relative">
                <Bell className="h-4 w-4" />
                Addenda
                {unacknowledgedAddenda > 0 && (
                  <span className="ml-1 h-2 w-2 rounded-full bg-destructive" />
                )}
              </TabsTrigger>
              <TabsTrigger value="submit" className="gap-2 relative">
                <Send className="h-4 w-4" />
                Submit
                {!currentSubmission && (
                  <span className="ml-1 h-2 w-2 rounded-full bg-primary" />
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="home">
              <BidHomeTab access={access} currentSubmission={currentSubmission} />
            </TabsContent>
            <TabsContent value="documents">
              <BidDocumentsTab files={data.packageFiles} />
            </TabsContent>
            <TabsContent value="addenda">
              <BidAddendaTab
                addenda={addenda}
                token={token}
                onAddendaChange={handleAddendaChange}
              />
            </TabsContent>
            <TabsContent value="submit">
              <BidSubmitTab
                token={token}
                access={access}
                currentSubmission={currentSubmission}
                submissions={data.submissions}
                onSubmissionChange={handleSubmissionChange}
              />
            </TabsContent>
          </Tabs>
        </main>
      )}
    </div>
  )
}
