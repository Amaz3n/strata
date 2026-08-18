"use client"

import { type ReactNode, useCallback, useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { PaymentHoldEvaluation } from "@/lib/services/payment-holds"
import type { PayableRunMembership } from "@/lib/services/org-payables"
import type { CompanyPaymentReadinessStatus } from "@/lib/services/vendor-payment-invitations"
import type { BudgetLineOption, ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import {
  getPayablesAccountingContextAction,
  getPayablesAccountingSyncStatesAction,
  approveVendorBillsAtomicAction,
  syncProjectVendorBillToAccountingAction,
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
import { billStatus } from "./workspace/payable-form"
import { PayableCreateWorkspace } from "./payable-create-workspace"
import { PayablesWorkspace } from "./payables-workspace"
import { AccountingSyncSheet } from "@/components/integrations/accounting-sync-sheet"
import type { AccountingSyncState } from "@/lib/services/accounting-sync-state"

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
  holdEvaluations = {},
  railOpen = false,
  paymentReadinessByCompanyId = {},
  runMembershipByBillId = {},
  viewerMayApproveRuns = false,
  approvalViewer = null,
  pagination,
  initialQueue,
  initialSearch,
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
  holdEvaluations?: Record<string, PaymentHoldEvaluation>
  railOpen?: boolean
  paymentReadinessByCompanyId?: Record<string, CompanyPaymentReadinessStatus>
  runMembershipByBillId?: Record<string, PayableRunMembership>
  viewerMayApproveRuns?: boolean
  approvalViewer?: {
    userId: string
    approvers: Array<{ userId: string; name: string }>
  } | null
  pagination: { page: number; pageSize: number; total: number; pageCount: number }
  initialQueue: string
  initialSearch: string
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()

  const [addPayableOpen, setAddPayableOpen] = useState(false)
  const [syncSheetOpen, setSyncSheetOpen] = useState(false)
  const [accountingEnabled, setAccountingEnabled] = useState(false)
  const [accountingProvider, setAccountingProvider] = useState<string | null>(null)
  const [accountingProviderName, setAccountingProviderName] = useState<string | null>(null)
  const [accountingSyncByBillId, setAccountingSyncByBillId] = useState<Record<string, AccountingSyncState>>({})
  const [customerPreview, setCustomerPreview] = useState<{ hasDefault: boolean; customerName: string | null } | null>(null)
  const [customerNudgeDismissed, setCustomerNudgeDismissed] = useState(false)
  const [qboExpenseAccounts, setQboExpenseAccounts] = useState<QBOAccountOption[]>([])
  const [qboApAccounts, setQboApAccounts] = useState<QBOAccountOption[]>([])
  const [qboDefaults, setQboDefaults] = useState<{ expenseAccountId?: string; apAccountId?: string }>({})
  const [accountingDimensions, setAccountingDimensions] = useState<Array<{
    key: string
    label: string
    values: QBOAccountOption[]
  }>>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])
  const [deleteBill, setDeleteBill] = useState<VendorBillSummary | null>(null)

  const [workspaceBillId, openBill] = useWorkspaceParam("bill")

  const getExpenseAccountName = (accountId?: string) => qboExpenseAccounts.find((account) => account.id === accountId)?.name
  const mayApproveBill = (bill: VendorBillSummary) =>
    !bill.preferred_approver_ids?.length ||
    Boolean(approvalViewer && bill.preferred_approver_ids.includes(approvalViewer.userId))
  useEffect(() => {
    let cancelled = false
    getPayablesAccountingContextAction(projectId)
      .then((context) => {
        if (cancelled) return
        setAccountingEnabled(Boolean(context.enabled))
        setAccountingProvider(context.provider ?? null)
        setAccountingProviderName(context.providerName ?? null)
        setQboExpenseAccounts(context.expenseAccounts ?? [])
        setQboApAccounts(context.apAccounts ?? [])
        setQboDefaults(context.defaults ?? {})
        setAccountingDimensions(context.dimensions ?? [])
        if (context.provider === "qbo") {
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
    if (!accountingEnabled) return
    void getPayablesAccountingSyncStatesAction(vendorBills.map((bill) => bill.id)).then(setAccountingSyncByBillId).catch(() => setAccountingSyncByBillId({}))
  }, [accountingEnabled, vendorBills])

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

  /**
   * Concurrency tokens the server moved without a user edit — opening a payable
   * caches its advisory approval signals, and that is a write. This list holds
   * the server-rendered token, so it has to learn the new one or an approval
   * would be rejected as a conflict nobody caused.
   */
  const [freshTokens, setFreshTokens] = useState<Record<string, string>>({})
  const noteFreshToken = useCallback((billId: string, updatedAt: string) => {
    setFreshTokens((current) => (current[billId] === updatedAt ? current : { ...current, [billId]: updatedAt }))
  }, [])
  const expectedToken = useCallback(
    (bill: { id: string; updated_at?: string }) => freshTokens[bill.id] ?? bill.updated_at,
    [freshTokens],
  )

  const approveBill = (bill: VendorBillSummary) => {
    if (isVendorCredit(bill)) return
    startTransition(async () => {
      try {
        const updated = unwrapAction(await updateProjectVendorBillStatusAction(projectId, bill.id, {
          status: "approved",
          expected_updated_at: expectedToken(bill),
          cost_code_id: costCodesEnabled ? bill.actual_cost_code_id ?? undefined : undefined,
          qbo_expense_account_id: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
          qbo_expense_account_name: bill.qbo_expense_account_name ?? getExpenseAccountName(qboDefaults.expenseAccountId),
        }))
        if (!updated.success) {
          toast.error(updated.error)
          return
        }
        if (updated.data.qbo_sync_status === "needs_review") {
          toast.warning(`Bill approved, but ${accountingProviderName ?? "accounting"} needs coding`, {
            description: updated.data.qbo_sync_error ?? "Choose an accounting category before syncing.",
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
      {accountingProvider === "qbo" && customerPreview && !customerPreview.hasDefault && !customerNudgeDismissed ? (
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
          vendorBills={vendorBills}
          costCodes={costCodes}
          costCodesEnabled={costCodesEnabled}
          accountingEnabled={accountingEnabled}
          externalAccountingEnabled={accountingEnabled && accountingProvider !== "arc_books"}
          runMembershipByBillId={runMembershipByBillId}
          accountingProviderName={accountingProviderName}
          qboExpenseAccounts={qboExpenseAccounts}
          complianceRules={complianceRules}
          complianceStatusByCompanyId={complianceStatusByCompanyId}
          toolbarLeading={toolbarLeading}
          fullBleed={fullBleed}
          pagination={pagination}
          initialQueue={initialQueue}
          initialSearch={initialSearch}
          onAddPayable={() => setAddPayableOpen(true)}
          onOpenSyncSheet={accountingProvider === "qbo" ? () => setSyncSheetOpen(true) : undefined}
          onSelectQboExpenseAccount={(bill, accountId) => {
            startTransition(async () => {
              try {
                const result = unwrapAction(await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: billStatus(bill),
                  expected_updated_at: expectedToken(bill),
                  qbo_expense_account_id: accountId || undefined,
                  qbo_expense_account_name: getExpenseAccountName(accountId),
                }))
                if (!result.success) {
                  toast.error(result.error)
                  return
                }
                toast.success("Accounting category updated")
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
                  status: billStatus(bill),
                  expected_updated_at: expectedToken(bill),
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
          mayApprove={mayApproveBill}
          onBulkApprove={(bills) => {
            startTransition(async () => {
              const result = await approveVendorBillsAtomicAction(bills.map((bill) => ({ id: bill.id, expected_updated_at: expectedToken(bill) })))
              if (!result.success) {
                toast.error(result.error, { description: "No payables were changed." })
                return
              }
              toast.success(`${result.data.approvedCount} payable${result.data.approvedCount === 1 ? "" : "s"} approved atomically`)
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
                unwrapAction(await syncProjectVendorBillToAccountingAction(projectId, bill.id))
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
              unwrapAction(await syncProjectVendorBillToAccountingAction(projectId, bill.id))
              toast.success(`Synced to ${accountingProviderName ?? "accounting"}`)
              router.refresh()
            })
          }}
          onDelete={setDeleteBill}
        />
      </div>

      <PayableCreateWorkspace
        projectId={projectId}
        projects={projects}
        open={addPayableOpen}
        onOpenChange={setAddPayableOpen}
        onSuccess={() => router.refresh()}
      />

      {accountingProvider === "qbo" ? <AccountingSyncSheet open={syncSheetOpen} onOpenChange={setSyncSheetOpen} projectId={projectId} /> : null}

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
        accountingProvider={accountingProvider}
        accountingProviderName={accountingProviderName}
        accountingSyncByBillId={accountingSyncByBillId}
        qboExpenseAccounts={qboExpenseAccounts}
        qboApAccounts={qboApAccounts}
        qboDefaults={qboDefaults}
        accountingDimensions={accountingDimensions}
        onChanged={() => router.refresh()}
        holdEvaluations={holdEvaluations}
        railOpen={railOpen}
        paymentReadinessByCompanyId={paymentReadinessByCompanyId}
        runMembershipByBillId={runMembershipByBillId}
        viewerMayApproveRuns={viewerMayApproveRuns}
        onConcurrencyTokenRefresh={noteFreshToken}
        approvalViewer={approvalViewer}
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
