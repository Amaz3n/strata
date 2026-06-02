"use client"

import type { Contact, CostCode, Contract, DrawSchedule, Invoice, Project, Retainage } from "@/lib/types"
import { InvoicesClient } from "@/components/invoices/invoices-client"
import { DrawScheduleManager } from "@/components/projects/draw-schedule-manager"
import { RetainageTracker } from "@/components/projects/retainage-tracker"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertTriangle, Receipt, Calendar, Percent } from "lucide-react"
import { useMemo, useState } from "react"
import { supportsApprovedCostInvoicing } from "@/lib/financials/billing-model"

interface ReceivablesTabProps {
  projectId: string
  project: Project
  invoices: Invoice[]
  draws: DrawSchedule[]
  retainage: Retainage[]
  contacts?: Contact[]
  costCodes?: CostCode[]
  contract: Contract | null
  approvedChangeOrdersTotalCents?: number
  scheduleItems?: any[]
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  loadErrors?: string[]
}

export function ReceivablesTab({
  projectId,
  project,
  invoices,
  draws,
  retainage,
  contacts,
  costCodes,
  contract,
  approvedChangeOrdersTotalCents,
  scheduleItems,
  builderInfo,
  loadErrors = [],
}: ReceivablesTabProps) {
  const [subTab, setSubTab] = useState<"invoices" | "draws" | "retainage">("invoices")
  const safeRetainage = useMemo(() => (Array.isArray(retainage) ? retainage : []), [retainage])
  const safeInvoices = useMemo(() => (Array.isArray(invoices) ? invoices : []), [invoices])
  const enableApprovedCostsSource = supportsApprovedCostInvoicing(contract)

  const tabCounts = {
    invoices: safeInvoices.length,
    draws: draws.length,
    retainage: safeRetainage.length,
  }

  function renderTabList() {
    return (
      <TabsList className="h-auto min-h-14 w-full justify-start overflow-x-auto rounded-none bg-transparent p-0 sm:w-auto">
        <TabsTrigger
          value="invoices"
          className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          <Receipt className="h-4 w-4" />
          Invoices
          <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
            {tabCounts.invoices}
          </Badge>
        </TabsTrigger>
        <TabsTrigger
          value="draws"
          className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          <Calendar className="h-4 w-4" />
          Draw Schedule
          <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
            {tabCounts.draws}
          </Badge>
        </TabsTrigger>
        <TabsTrigger
          value="retainage"
          className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
        >
          <Percent className="h-4 w-4" />
          Retainage
          <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
            {tabCounts.retainage}
          </Badge>
        </TabsTrigger>
      </TabsList>
    )
  }

  return (
    <div className="w-full">
      {loadErrors.length > 0 ? (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6 lg:px-8">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">Some receivable data could not load.</p>
              <p className="mt-1 text-amber-800">{loadErrors.join(" · ")}</p>
            </div>
          </div>
        </div>
      ) : null}
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as "invoices" | "draws" | "retainage")} className="w-full gap-0">
        <TabsContent value="invoices" className="m-0">
          <InvoicesClient
            invoices={invoices}
            projects={[project]}
            builderInfo={builderInfo}
            contacts={contacts}
            costCodes={costCodes}
            enableApprovedCostsSource={enableApprovedCostsSource}
            toolbarLeading={renderTabList()}
            fullBleed
            projectScoped
          />
        </TabsContent>

        <TabsContent value="draws" className="m-0">
          <div className="border-b bg-background/95 px-4 sm:px-6 lg:px-8">{renderTabList()}</div>
          <div>
            <DrawScheduleManager
              projectId={projectId}
              initialDraws={draws}
              contract={contract}
              approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
              scheduleItems={scheduleItems}
              costCodes={costCodes}
            />
          </div>
        </TabsContent>

        <TabsContent value="retainage" className="m-0">
          <div className="border-b bg-background/95 px-4 sm:px-6 lg:px-8">{renderTabList()}</div>
          <div className="p-4 sm:p-6 lg:p-8">
            <RetainageTracker projectId={projectId} project={project} retainage={safeRetainage} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
