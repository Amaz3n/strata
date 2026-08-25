"use client"

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { ExpenseWorkspace } from "@/components/expenses/expense-workspace"
import { PayablesWorkspace } from "@/components/payables/payables-workspace"
import { InvoiceDetailSheet } from "@/components/invoices/invoice-detail-sheet"
import type { ProjectExpense } from "@/components/expenses/expense-shared"
import {
  getExpenseAccountingContextAction,
  listProjectExpensesAction,
} from "@/app/(app)/projects/[id]/expenses/actions"
import { fetchPayablesTabDataAction } from "@/app/(app)/projects/[id]/financials/actions"
import { getPayablesAccountingContextAction } from "@/app/(app)/projects/[id]/payables/actions"
import { getInvoiceDetailAction } from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { listProjectBillingOptionsAction } from "@/app/(app)/projects/actions"
import type {
  Invoice,
  InvoiceLienWaiver,
  InvoiceView,
  Payment,
  PaymentReversal,
} from "@/lib/types"
import type { ProjectBillingModel } from "@/lib/financials/billing-model"

export type ReviewOverlayTarget = {
  kind: "expense" | "vendor_bill" | "invoice"
  id: string
  /**
   * The project that owns this record. Org-wide registers (a vendor account,
   * for instance) list rows from many projects, so the target carries its own
   * project rather than inheriting one fixed project from the consumer.
   */
  projectId?: string
  /** Per-project cost-code setting, when the consumer already resolved it. */
  costCodesEnabled?: boolean
}

type ExpenseAccountingContext = Awaited<ReturnType<typeof getExpenseAccountingContextAction>>
type PayablesBundle = Awaited<ReturnType<typeof fetchPayablesTabDataAction>>
type PayablesAccounting = Awaited<ReturnType<typeof getPayablesAccountingContextAction>>
type ProjectOption = { id: string; name: string; billingModel: ProjectBillingModel }

interface InvoiceBundle {
  invoice: Invoice | null
  link?: string
  views?: InvoiceView[]
  syncHistory?: Array<{
    id: string
    status: string
    last_synced_at: string
    error_message?: string | null
    qbo_id?: string | null
  }>
  payments?: Payment[]
  reversals?: PaymentReversal[]
  lienWaivers?: InvoiceLienWaiver[]
}

export function ReviewDetailOverlays({
  projectId,
  costCodesEnabled,
  target,
  onClose,
}: {
  /** Default project for consumers scoped to exactly one. */
  projectId?: string
  costCodesEnabled: boolean
  target: ReviewOverlayTarget | null
  onClose: () => void
}) {
  // The row being opened wins; the prop is the single-project fallback.
  const activeProjectId = target?.projectId ?? projectId ?? null
  const activeCostCodesEnabled = target?.costCodesEnabled ?? costCodesEnabled
  const router = useRouter()
  const [activeKind, setActiveKind] = useState<ReviewOverlayTarget["kind"] | null>(null)
  const [loading, setLoading] = useState(false)

  const [expenseId, setExpenseId] = useState<string | null>(null)
  const [expenses, setExpenses] = useState<ProjectExpense[] | null>(null)
  const [expenseCtx, setExpenseCtx] = useState<ExpenseAccountingContext | null>(null)

  const [billId, setBillId] = useState<string | null>(null)
  const [payables, setPayables] = useState<PayablesBundle | null>(null)
  const [payablesAccounting, setPayablesAccounting] = useState<PayablesAccounting | null>(null)
  const [projects, setProjects] = useState<ProjectOption[]>([])

  const [invoiceOpen, setInvoiceOpen] = useState(false)
  const [invoiceLoading, setInvoiceLoading] = useState(false)
  const [invoice, setInvoice] = useState<InvoiceBundle | null>(null)

  const closeAll = useCallback(() => {
    setActiveKind(null)
    setExpenseId(null)
    setBillId(null)
    setInvoiceOpen(false)
    onClose()
  }, [onClose])

  const openExpense = useCallback(
    async (id: string, forProjectId: string) => {
      setActiveKind("expense")
      setExpenseId(id)
      setLoading(true)
      try {
        const [list, ctx] = await Promise.all([
          listProjectExpensesAction(forProjectId),
          getExpenseAccountingContextAction(forProjectId),
        ])
        setExpenses(list as ProjectExpense[])
        setExpenseCtx(ctx)
      } catch (error: any) {
        toast.error("Could not open expense", { description: error?.message })
        closeAll()
      } finally {
        setLoading(false)
      }
    },
    [closeAll],
  )

  const openBill = useCallback(
    async (id: string, forProjectId: string) => {
      setActiveKind("vendor_bill")
      setBillId(id)
      setLoading(true)
      try {
        const [bundle, accounting, projectRows] = await Promise.all([
          fetchPayablesTabDataAction(forProjectId),
          getPayablesAccountingContextAction(forProjectId),
          listProjectBillingOptionsAction(),
        ])
        setPayables(bundle)
        setPayablesAccounting(accounting)
        setProjects(projectRows ?? [])
      } catch (error: any) {
        toast.error("Could not open bill", { description: error?.message })
        closeAll()
      } finally {
        setLoading(false)
      }
    },
    [closeAll],
  )

  const openInvoice = useCallback(
    async (id: string) => {
      setActiveKind("invoice")
      setInvoiceOpen(true)
      setInvoiceLoading(true)
      setInvoice(null)
      try {
        const result = unwrapAction(await getInvoiceDetailAction(id))
        setInvoice({
          invoice: result.invoice as Invoice,
          link: result.link,
          views: result.views as InvoiceView[],
          syncHistory: result.syncHistory as InvoiceBundle["syncHistory"],
          payments: (result.payments as Payment[]) ?? [],
          reversals: (result.reversals as PaymentReversal[]) ?? [],
          lienWaivers: (result.lienWaivers as InvoiceLienWaiver[]) ?? [],
        })
      } catch (error: any) {
        toast.error("Could not open invoice", { description: error?.message })
        setInvoiceOpen(false)
        closeAll()
      } finally {
        setInvoiceLoading(false)
      }
    },
    [closeAll],
  )

  // A fresh target object arrives on every row click; open the matching overlay.
  useEffect(() => {
    if (!target) return
    if (target.kind === "invoice") {
      void openInvoice(target.id)
      return
    }
    const forProjectId = target.projectId ?? projectId
    if (!forProjectId) {
      toast.error("Could not open this record", { description: "It is not linked to a project." })
      closeAll()
      return
    }
    if (target.kind === "expense") void openExpense(target.id, forProjectId)
    else void openBill(target.id, forProjectId)
  }, [target, projectId, openExpense, openBill, openInvoice, closeAll])

  const handleChanged = useCallback(() => {
    router.refresh()
  }, [router])

  const reloadInvoice = useCallback(async () => {
    if (!invoice?.invoice?.id) return
    const result = unwrapAction(await getInvoiceDetailAction(invoice.invoice.id))
    setInvoice({
      invoice: result.invoice as Invoice,
      link: result.link,
      views: result.views as InvoiceView[],
      syncHistory: result.syncHistory as InvoiceBundle["syncHistory"],
      payments: (result.payments as Payment[]) ?? [],
      reversals: (result.reversals as PaymentReversal[]) ?? [],
      lienWaivers: (result.lienWaivers as InvoiceLienWaiver[]) ?? [],
    })
    router.refresh()
  }, [invoice?.invoice?.id, router])

  const showExpense = activeKind === "expense" && !loading && expenses && expenseCtx
  const showBill = activeKind === "vendor_bill" && !loading && payables && payablesAccounting
  const showLoader = loading && (activeKind === "expense" || activeKind === "vendor_bill")

  return (
    <>
      {showLoader ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : null}

      {showExpense ? (
        <ExpenseWorkspace
          projectId={activeProjectId ?? ""}
          expenses={expenses ?? []}
          selectedExpenseId={expenseId}
          onSelect={(id) => {
            if (id) setExpenseId(id)
            else closeAll()
          }}
          accountingContext={expenseCtx}
          costCodesEnabled={expenseCtx?.costCodesEnabled ?? activeCostCodesEnabled}
          onChanged={handleChanged}
        />
      ) : null}

      {showBill && payables && payablesAccounting ? (
        <PayablesWorkspace
          projectId={activeProjectId ?? ""}
          bills={payables.vendorBills}
          selectedBillId={billId}
          onSelectBill={(id) => {
            if (id) setBillId(id)
            else closeAll()
          }}
          costCodes={payables.costCodes}
          budgetLines={payables.budgetLines}
          costCodesEnabled={activeCostCodesEnabled}
          projects={projects}
          accountingEnabled={Boolean(payablesAccounting.enabled)}
          qboExpenseAccounts={payablesAccounting.expenseAccounts ?? []}
          qboApAccounts={payablesAccounting.apAccounts ?? []}
          qboDefaults={payablesAccounting.defaults ?? {}}
          onChanged={handleChanged}
        />
      ) : null}

      <InvoiceDetailSheet
        open={invoiceOpen}
        onOpenChange={(open) => {
          if (!open) {
            setInvoiceOpen(false)
            closeAll()
          }
        }}
        invoice={invoice?.invoice}
        link={invoice?.link}
        views={invoice?.views}
        syncHistory={invoice?.syncHistory}
        payments={invoice?.payments}
        reversals={invoice?.reversals}
        lienWaivers={invoice?.lienWaivers}
        loading={invoiceLoading}
        onPaymentRecorded={reloadInvoice}
        onWaiversChanged={reloadInvoice}
      />
    </>
  )
}
