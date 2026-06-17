"use client"

import { type ReactNode, useEffect, useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { BudgetLineOption, ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import {
  getPayablesAccountingContextAction,
  syncProjectVendorBillToQBOAction,
  updateProjectVendorBillStatusAction,
  deleteProjectVendorBillAction,
} from "@/app/(app)/projects/[id]/payables/actions"
import { getProjectAccountingCustomerPreviewAction } from "@/app/(app)/projects/actions"
import { listProjectsAction } from "@/app/(app)/projects/actions"

import { cn } from "@/lib/utils"
import { isVendorCredit } from "@/lib/financials/payables-rules"
import { PayablesExplorer } from "./payables-explorer"
import { AddPayableSheet } from "./add-payable-sheet"
import { PayablesWorkspace } from "./payables-workspace"
import { QboSyncSheet } from "@/components/integrations/qbo-sync-sheet"

type QBOAccountOption = { id: string; name: string; fullyQualifiedName?: string; account_type?: string; account_sub_type?: string }
type ProjectBillingModel = "fixed_price" | "cost_plus_percent" | "cost_plus_fixed_fee" | "cost_plus_gmp" | "time_and_materials"
type ProjectOption = { id: string; name: string; billingModel: ProjectBillingModel }

function getPayableSyncBlockReason(bill: VendorBillSummary) {
  if (isVendorCredit(bill)) return "Imported vendor credits are read-only in QuickBooks."
  if (bill.status === "pending") return "Approve the payable before syncing it to QuickBooks."
  if (!bill.qbo_vendor_id) return "Link this Arc vendor to QuickBooks before syncing."
  const hasLineExpenseCoding =
    (bill.actual_lines?.length ?? 0) > 0 && bill.actual_lines!.every((line) => Boolean(line.qbo_expense_account_id))
  if (!bill.qbo_expense_account_id && !hasLineExpenseCoding) return "Choose a QuickBooks account before syncing this payable."
  return null
}

export function ProjectPayablesClient({
  projectId,
  vendorBills,
  costCodes,
  budgetLines = [],
  costCodesEnabled = true,
  billingModel,
  complianceRules,
  complianceStatusByCompanyId,
  toolbarLeading,
  fullBleed = false,
}: {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  budgetLines?: BudgetLineOption[]
  costCodesEnabled?: boolean
  billingModel: ProjectBillingModel
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  toolbarLeading?: ReactNode
  fullBleed?: boolean
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  const [addPayableOpen, setAddPayableOpen] = useState(false)
  const [syncSheetOpen, setSyncSheetOpen] = useState(false)
  const [accountingEnabled, setAccountingEnabled] = useState(false)
  const [customerPreview, setCustomerPreview] = useState<{ hasDefault: boolean; customerName: string | null } | null>(null)
  const [customerNudgeDismissed, setCustomerNudgeDismissed] = useState(false)
  const [qboExpenseAccounts, setQboExpenseAccounts] = useState<QBOAccountOption[]>([])
  const [qboApAccounts, setQboApAccounts] = useState<QBOAccountOption[]>([])
  const [qboDefaults, setQboDefaults] = useState<{ expenseAccountId?: string; apAccountId?: string }>({})
  const [projects, setProjects] = useState<ProjectOption[]>([])

  const [workspaceBillId, setWorkspaceBillId] = useState<string | null>(searchParams.get("bill"))

  const urlBillId = searchParams.get("bill")
  useEffect(() => {
    setWorkspaceBillId(urlBillId)
  }, [urlBillId])

  const openBill = (billId: string | null) => {
    setWorkspaceBillId(billId)
    if (typeof window === "undefined") return
    const params = new URLSearchParams(window.location.search)
    if (billId) params.set("bill", billId)
    else params.delete("bill")
    const query = params.toString()
    window.history.replaceState(null, "", query ? `${pathname}?${query}` : pathname)
  }

  const getExpenseAccountName = (accountId?: string) => qboExpenseAccounts.find((account) => account.id === accountId)?.name
  useEffect(() => {
    let cancelled = false
    getPayablesAccountingContextAction()
      .then((context) => {
        if (cancelled) return
        setAccountingEnabled(Boolean(context.enabled))
        setQboExpenseAccounts(context.expenseAccounts ?? [])
        setQboApAccounts(context.apAccounts ?? [])
        setQboDefaults(context.defaults ?? {})
        if (context.enabled) {
          getProjectAccountingCustomerPreviewAction(projectId)
            .then((preview) => {
              if (!cancelled) setCustomerPreview(preview)
            })
            .catch(() => {})
        }
      })
      .catch(() => {
        if (!cancelled) setAccountingEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    listProjectsAction()
      .then((rows) => {
        if (cancelled) return
        setProjects(
          (rows ?? []).map((project: any) => ({
            id: project.id,
            name: project.name,
            billingModel: project.financial_settings?.billing_model ?? "fixed_price",
          })),
        )
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    setProjects((current) => {
      if (current.some((project) => project.id === projectId)) return current
      return [{ id: projectId, name: "Current project", billingModel }, ...current]
    })
  }, [billingModel, projectId])

  const approveBill = (bill: VendorBillSummary) => {
    if (isVendorCredit(bill)) return
    startTransition(async () => {
      try {
        const updated = await updateProjectVendorBillStatusAction(projectId, bill.id, {
          status: "approved",
          cost_code_id: costCodesEnabled ? bill.actual_cost_code_id ?? undefined : undefined,
          qbo_expense_account_id: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
          qbo_expense_account_name: bill.qbo_expense_account_name ?? getExpenseAccountName(qboDefaults.expenseAccountId),
        })
        if (updated.qbo_sync_status === "needs_review") {
          toast.warning("Bill approved, but QuickBooks needs coding", {
            description: updated.qbo_sync_error ?? "Choose a QuickBooks account before syncing.",
          })
        } else {
          toast.success("Bill approved")
        }
        router.refresh()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  return (
    <div className={fullBleed ? "w-full" : "h-full flex flex-col"}>
      {accountingEnabled && customerPreview && !customerPreview.hasDefault && !customerNudgeDismissed ? (
        <div
          className={cn(
            "mb-3 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-900",
            fullBleed && "mx-4 sm:mx-6 lg:mx-8",
          )}
        >
          <p>
            Payables sync to QuickBooks under{" "}
            <span className="font-medium">{customerPreview.customerName ?? "this project's client"}</span>. Set a default
            customer in project settings to control cost attribution.
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <button type="button" onClick={() => router.push(`/projects/${projectId}`)} className="font-medium underline-offset-2 hover:underline">
              Project settings
            </button>
            <button type="button" onClick={() => setCustomerNudgeDismissed(true)} className="text-amber-700 transition-colors hover:text-amber-900">
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className={fullBleed ? "w-full" : "flex-1 overflow-hidden border rounded-xl bg-card shadow-sm"}>
        <PayablesExplorer
          projectId={projectId}
          vendorBills={vendorBills}
          costCodes={costCodes}
          costCodesEnabled={costCodesEnabled}
          qboExpenseAccounts={qboExpenseAccounts}
          complianceRules={complianceRules}
          complianceStatusByCompanyId={complianceStatusByCompanyId}
          toolbarLeading={toolbarLeading}
          fullBleed={fullBleed}
          onAddPayable={() => setAddPayableOpen(true)}
          onOpenSyncSheet={() => setSyncSheetOpen(true)}
          onEditVendor={(bill) => openBill(bill.id)}
          onSelectQboExpenseAccount={(bill, accountId) => {
            startTransition(async () => {
              try {
                await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: bill.status as any,
                  qbo_expense_account_id: accountId || undefined,
                  qbo_expense_account_name: getExpenseAccountName(accountId),
                })
                toast.success("QuickBooks account updated")
                router.refresh()
              } catch (error) {
                toast.error((error as Error).message)
              }
            })
          }}
          onSelectCostCode={costCodesEnabled ? (bill, costCodeId) => {
            startTransition(async () => {
              try {
                await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: bill.status as any,
                  cost_code_id: costCodeId,
                  qbo_expense_account_id: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
                  qbo_expense_account_name: bill.qbo_expense_account_name ?? getExpenseAccountName(qboDefaults.expenseAccountId),
                })
                toast.success("Cost code updated")
                router.refresh()
              } catch (error) {
                toast.error((error as Error).message)
              }
            })
          } : undefined}
          onViewDetails={(bill) => openBill(bill.id)}
          onViewFiles={(bill) => openBill(bill.id)}
          onRecordPayment={(bill) => openBill(bill.id)}
          onApprove={approveBill}
          onSyncQbo={(bill) => {
            startTransition(async () => {
              const blockReason = getPayableSyncBlockReason(bill)
              if (blockReason) {
                toast.error(blockReason)
                if (!bill.qbo_vendor_id) openBill(bill.id)
                return
              }
              const result = await syncProjectVendorBillToQBOAction(projectId, bill.id)
              if (result.success) {
                toast.success("Synced to QuickBooks")
                router.refresh()
              } else {
                toast.error(result.error ?? "QuickBooks sync failed")
                router.refresh()
              }
            })
          }}
          onDelete={(bill) => {
            if (!window.confirm(`Are you sure you want to delete payable ${bill.bill_number ? `#${bill.bill_number}` : ""} for ${bill.company_name ?? "unknown vendor"}?`)) {
              return
            }
            startTransition(async () => {
              const result = await deleteProjectVendorBillAction(projectId, bill.id)
              if (result.success) {
                toast.success("Payable deleted")
                router.refresh()
              } else {
                toast.error(result.error)
              }
            })
          }}
        />
      </div>

      <AddPayableSheet projectId={projectId} open={addPayableOpen} onOpenChange={setAddPayableOpen} onSuccess={() => router.refresh()} />

      <QboSyncSheet open={syncSheetOpen} onOpenChange={setSyncSheetOpen} projectId={projectId} />

      <PayablesWorkspace
        projectId={projectId}
        bills={vendorBills}
        selectedBillId={workspaceBillId}
        onSelectBill={openBill}
        costCodes={costCodes}
        budgetLines={budgetLines}
        costCodesEnabled={costCodesEnabled}
        projects={projects}
        accountingEnabled={accountingEnabled}
        qboExpenseAccounts={qboExpenseAccounts}
        qboApAccounts={qboApAccounts}
        qboDefaults={qboDefaults}
        complianceRules={complianceRules}
        complianceStatusByCompanyId={complianceStatusByCompanyId}
        onChanged={() => router.refresh()}
      />
    </div>
  )
}
