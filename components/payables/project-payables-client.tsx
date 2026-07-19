"use client"

import { type ReactNode, useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
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
import { getPayableSyncBlockReason, isVendorCredit } from "@/lib/financials/payables-rules"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { useWorkspaceParam } from "@/components/financials/workspace/use-workspace-param"
import { PayablesExplorer } from "./payables-explorer"
import { AddPayableSheet } from "./add-payable-sheet"
import { PayablesWorkspace } from "./payables-workspace"
import { QboSyncSheet } from "@/components/integrations/qbo-sync-sheet"

import { unwrapAction } from "@/lib/action-result"

type QBOAccountOption = { id: string; name: string; fullyQualifiedName?: string; account_type?: string; account_sub_type?: string }
type ProjectBillingModel = "fixed_price" | "cost_plus_percent" | "cost_plus_fixed_fee" | "cost_plus_gmp" | "time_and_materials"
type ProjectOption = { id: string; name: string; billingModel: ProjectBillingModel }

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
  const [deleteBill, setDeleteBill] = useState<VendorBillSummary | null>(null)

  const [workspaceBillId, openBill] = useWorkspaceParam("bill")

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
        const updated = unwrapAction(await updateProjectVendorBillStatusAction(projectId, bill.id, {
          status: "approved",
          expected_updated_at: bill.updated_at,
          cost_code_id: costCodesEnabled ? bill.actual_cost_code_id ?? undefined : undefined,
          qbo_expense_account_id: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
          qbo_expense_account_name: bill.qbo_expense_account_name ?? getExpenseAccountName(qboDefaults.expenseAccountId),
        }))
        if (!updated.success) {
          toast.error(updated.error)
          return
        }
        if (updated.data.qbo_sync_status === "needs_review") {
          toast.warning("Bill approved, but QuickBooks needs coding", {
            description: updated.data.qbo_sync_error ?? "Choose a QuickBooks account before syncing.",
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
            "mb-3 flex items-start justify-between gap-3 border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-foreground",
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
            <button type="button" onClick={() => setCustomerNudgeDismissed(true)} className="text-muted-foreground transition-colors hover:text-foreground">
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div className={fullBleed ? "w-full" : "flex-1 overflow-hidden border bg-card"}>
        <PayablesExplorer
          projectId={projectId}
          vendorBills={vendorBills}
          costCodes={costCodes}
          costCodesEnabled={costCodesEnabled}
          accountingEnabled={accountingEnabled}
          qboExpenseAccounts={qboExpenseAccounts}
          complianceRules={complianceRules}
          complianceStatusByCompanyId={complianceStatusByCompanyId}
          toolbarLeading={toolbarLeading}
          fullBleed={fullBleed}
          onAddPayable={() => setAddPayableOpen(true)}
          onOpenSyncSheet={() => setSyncSheetOpen(true)}
          onSelectQboExpenseAccount={(bill, accountId) => {
            startTransition(async () => {
              try {
                const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: bill.status as any,
                  expected_updated_at: bill.updated_at,
                  qbo_expense_account_id: accountId || undefined,
                  qbo_expense_account_name: getExpenseAccountName(accountId),
                }))
                if (!result.success) {
                  toast.error(result.error)
                  return
                }
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
                const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: bill.status as any,
                  expected_updated_at: bill.updated_at,
                  cost_code_id: costCodeId,
                  qbo_expense_account_id: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
                  qbo_expense_account_name: bill.qbo_expense_account_name ?? getExpenseAccountName(qboDefaults.expenseAccountId),
                }))
                if (!result.success) {
                  toast.error(result.error)
                  return
                }
                toast.success("Cost code updated")
                router.refresh()
              } catch (error) {
                toast.error((error as Error).message)
              }
            })
          } : undefined}
          onViewDetails={(bill) => openBill(bill.id)}
          onApprove={approveBill}
          onBulkApprove={(bills) => {
            startTransition(async () => {
              let approved = 0
              for (const bill of bills) {
                const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: "approved",
                  expected_updated_at: bill.updated_at,
                  cost_code_id: costCodesEnabled ? bill.actual_cost_code_id ?? undefined : undefined,
                  qbo_expense_account_id: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
                  qbo_expense_account_name: bill.qbo_expense_account_name ?? getExpenseAccountName(qboDefaults.expenseAccountId),
                }))
                if (result.success) approved += 1
                else toast.error(result.error, { description: bill.bill_number ?? undefined })
              }
              if (approved > 0) toast.success(`${approved} payable${approved === 1 ? "" : "s"} approved`)
              router.refresh()
            })
          }}
          onBulkSyncQbo={(bills) => {
            startTransition(async () => {
              let synced = 0
              for (const bill of bills) {
                const blockReason = getPayableSyncBlockReason(bill)
                if (blockReason) {
                  toast.error(blockReason, { description: bill.bill_number ?? undefined })
                  continue
                }
                unwrapAction(await syncProjectVendorBillToQBOAction(projectId, bill.id))
                synced += 1
              }
              if (synced > 0) toast.success(`${synced} payable${synced === 1 ? "" : "s"} synced`)
              router.refresh()
            })
          }}
          onSyncQbo={(bill) => {
            startTransition(async () => {
              const blockReason = getPayableSyncBlockReason(bill)
              if (blockReason) {
                toast.error(blockReason)
                if (!bill.qbo_vendor_id) openBill(bill.id)
                return
              }
              unwrapAction(await syncProjectVendorBillToQBOAction(projectId, bill.id))
              toast.success("Synced to QuickBooks")
              router.refresh()
            })
          }}
          onDelete={setDeleteBill}
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

      <AlertDialog open={Boolean(deleteBill)} onOpenChange={(open) => !open && setDeleteBill(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete payable?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes {deleteBill?.bill_number ? `#${deleteBill.bill_number}` : "this payable"} for{" "}
              {deleteBill?.company_name ?? deleteBill?.qbo_vendor_name ?? "unknown vendor"}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleteBill) return
                startTransition(async () => {
                  const result = unwrapAction(await deleteProjectVendorBillAction(projectId, deleteBill.id))
                  if (result.success) {
                    toast.success("Payable deleted")
                    setDeleteBill(null)
                    router.refresh()
                  } else {
                    toast.error(result.error)
                  }
                })
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
