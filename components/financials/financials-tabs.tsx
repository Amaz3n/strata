"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import type {
  Contract,
  DrawSchedule,
  Retainage,
  ScheduleItem,
  Project,
  CostCode,
  Contact,
  Invoice,
  Company,
  ComplianceRules,
  ComplianceStatusSummary,
} from "@/lib/types"
import type { ProjectStats } from "@/app/(app)/projects/[id]/actions"
import type { CommitmentSummary } from "@/lib/services/commitments"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { OverviewTab } from "./overview-tab"
import { BudgetTab } from "./budget-tab"
import { ReceivablesTab } from "./receivables-tab"
import { PayablesTab } from "./payables-tab"
import { TabSkeleton } from "./tab-skeleton"
import { LayoutDashboard, DollarSign, Receipt, CreditCard } from "lucide-react"

import {
  fetchBudgetTabDataAction,
  fetchReceivablesTabDataAction,
  fetchPayablesTabDataAction,
} from "@/app/(app)/projects/[id]/financials/actions"

type TabValue = "overview" | "budget" | "receivables" | "payables"

interface FinancialsTabsProps {
  projectId: string
  project: Project
  initialTab?: string
  // Overview data (always loaded)
  contract: Contract | null
  budgetSummary?: ProjectStats["budgetSummary"]
  approvedChangeOrdersTotalCents: number
  scheduleItems: ScheduleItem[]
  draws: DrawSchedule[]
  retainage: Retainage[]
  // Builder info for invoices
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
}

export function FinancialsTabs({
  projectId,
  project,
  initialTab,
  contract,
  budgetSummary,
  approvedChangeOrdersTotalCents,
  scheduleItems,
  draws,
  retainage,
  builderInfo,
}: FinancialsTabsProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Parse initial tab from URL or props
  const getInitialTab = (): TabValue => {
    const urlTab = searchParams.get("tab")
    if (urlTab && ["overview", "budget", "receivables", "payables"].includes(urlTab)) {
      return urlTab as TabValue
    }
    if (initialTab && ["overview", "budget", "receivables", "payables"].includes(initialTab)) {
      return initialTab as TabValue
    }
    return "overview"
  }

  const [activeTab, setActiveTab] = useState<TabValue>(getInitialTab)

  // Track which tabs have been fetched
  const [hasFetchedBudget, setHasFetchedBudget] = useState(false)
  const [hasFetchedReceivables, setHasFetchedReceivables] = useState(false)
  const [hasFetchedPayables, setHasFetchedPayables] = useState(false)

  // Loading states
  const [loadingBudget, setLoadingBudget] = useState(false)
  const [loadingReceivables, setLoadingReceivables] = useState(false)
  const [loadingPayables, setLoadingPayables] = useState(false)

  // Tab data
  const [budgetData, setBudgetData] = useState<any>(null)
  const [costCodes, setCostCodes] = useState<CostCode[]>([])
  const [varianceAlerts, setVarianceAlerts] = useState<any[]>([])
  const [commitments, setCommitments] = useState<CommitmentSummary[]>([])
  const [companies, setCompanies] = useState<Company[]>([])

  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [invoiceCostCodes, setInvoiceCostCodes] = useState<CostCode[]>([])

  const [vendorBills, setVendorBills] = useState<VendorBillSummary[]>([])
  const [complianceRules, setComplianceRules] = useState<ComplianceRules>({
    require_insurance: false,
    require_w9: false,
    require_license: false,
    require_lien_waiver: false,
    block_payment_on_missing_docs: false,
  })
  const [complianceStatusByCompanyId, setComplianceStatusByCompanyId] = useState<
    Record<string, ComplianceStatusSummary>
  >({})

  // Update URL when tab changes
  const handleTabChange = useCallback(
    (tab: string) => {
      const newTab = tab as TabValue
      setActiveTab(newTab)

      const params = new URLSearchParams(searchParams.toString())
      if (newTab === "overview") {
        params.delete("tab")
      } else {
        params.set("tab", newTab)
      }

      const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname
      router.replace(newUrl, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  // Lazy load budget tab data
  useEffect(() => {
    if (activeTab === "budget" && !hasFetchedBudget && !loadingBudget) {
      setLoadingBudget(true)
      fetchBudgetTabDataAction(projectId)
        .then((data) => {
          setBudgetData(data.budgetData)
          setCostCodes(data.costCodes)
          setVarianceAlerts(data.varianceAlerts)
          setCommitments(data.commitments)
          setCompanies(data.companies)
          setHasFetchedBudget(true)
        })
        .catch((error) => {
          console.error("Failed to load budget tab data:", error)
        })
        .finally(() => {
          setLoadingBudget(false)
        })
    }
  }, [activeTab, hasFetchedBudget, loadingBudget, projectId])

  // Lazy load receivables tab data
  useEffect(() => {
    if (activeTab === "receivables" && !hasFetchedReceivables && !loadingReceivables) {
      setLoadingReceivables(true)
      fetchReceivablesTabDataAction(projectId)
        .then((data) => {
          setInvoices(data.invoices)
          setContacts(data.contacts)
          setInvoiceCostCodes(data.costCodes)
          setHasFetchedReceivables(true)
        })
        .catch((error) => {
          console.error("Failed to load receivables tab data:", error)
        })
        .finally(() => {
          setLoadingReceivables(false)
        })
    }
  }, [activeTab, hasFetchedReceivables, loadingReceivables, projectId])

  // Lazy load payables tab data
  useEffect(() => {
    if (activeTab === "payables" && !hasFetchedPayables && !loadingPayables) {
      setLoadingPayables(true)
      fetchPayablesTabDataAction(projectId)
        .then((data) => {
          setVendorBills(data.vendorBills)
          setComplianceRules(data.complianceRules)
          setComplianceStatusByCompanyId(data.complianceStatusByCompanyId ?? {})
          setHasFetchedPayables(true)
        })
        .catch((error) => {
          console.error("Failed to load payables tab data:", error)
        })
        .finally(() => {
          setLoadingPayables(false)
        })
    }
  }, [activeTab, hasFetchedPayables, loadingPayables, projectId])

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
      {/* Sticky Tab Bar */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-b mb-6">
        <div className="w-full">
          <TabsList className="h-11 w-full justify-start gap-1 overflow-x-auto bg-transparent p-0 border-0">
            <TabsTrigger
              value="overview"
              className="min-w-fit gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-sm px-4"
            >
              <LayoutDashboard className="h-4 w-4" />
              <span className="hidden sm:inline">Overview</span>
            </TabsTrigger>
            <TabsTrigger
              value="budget"
              className="min-w-fit gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-sm px-4"
            >
              <DollarSign className="h-4 w-4" />
              <span className="hidden sm:inline">Budget</span>
            </TabsTrigger>
            <TabsTrigger
              value="receivables"
              className="min-w-fit gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-sm px-4"
            >
              <Receipt className="h-4 w-4" />
              <span className="hidden sm:inline">Receivables</span>
            </TabsTrigger>
            <TabsTrigger
              value="payables"
              className="min-w-fit gap-2 data-[state=active]:bg-muted data-[state=active]:shadow-sm px-4"
            >
              <CreditCard className="h-4 w-4" />
              <span className="hidden sm:inline">Payables</span>
            </TabsTrigger>
          </TabsList>
        </div>
      </div>

      {/* Tab Content */}
      <TabsContent value="overview" className="mt-0">
        <OverviewTab
          projectId={projectId}
          contract={contract}
          approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
          draws={draws}
          retainage={retainage}
          budgetSummary={budgetSummary}
          scheduleItems={scheduleItems}
          onNavigateToTab={handleTabChange}
        />
      </TabsContent>

      <TabsContent value="budget" className="mt-0">
        {loadingBudget ? (
          <TabSkeleton />
        ) : hasFetchedBudget ? (
          <BudgetTab
            projectId={projectId}
            budgetData={budgetData}
            costCodes={costCodes}
            varianceAlerts={varianceAlerts}
            commitments={commitments}
            companies={companies}
          />
        ) : null}
      </TabsContent>

      <TabsContent value="receivables" className="mt-0">
        {loadingReceivables ? (
          <TabSkeleton />
        ) : hasFetchedReceivables ? (
          <ReceivablesTab
            projectId={projectId}
            project={project}
            invoices={invoices}
            draws={draws}
            retainage={retainage}
            contacts={contacts}
            costCodes={invoiceCostCodes}
            contract={contract}
            approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
            scheduleItems={scheduleItems}
            builderInfo={builderInfo}
          />
        ) : null}
      </TabsContent>

      <TabsContent value="payables" className="mt-0">
        {loadingPayables ? (
          <TabSkeleton />
        ) : hasFetchedPayables ? (
          <PayablesTab
            projectId={projectId}
            vendorBills={vendorBills}
            complianceRules={complianceRules}
            complianceStatusByCompanyId={complianceStatusByCompanyId}
          />
        ) : null}
      </TabsContent>
    </Tabs>
  )
}
