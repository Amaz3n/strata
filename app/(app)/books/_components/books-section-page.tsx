import { PageLayout } from "@/components/layout/page-layout"
import { getBooksWorkspace } from "@/lib/services/books/workspace"
import { notFound } from "next/navigation"

import { BooksClient, type BooksSection } from "../books-client"

const TITLES: Record<BooksSection, string> = {
  overview: "Books",
  transactions: "Books · Transactions",
  banking: "Books · Banking",
  chart: "Books · Chart of accounts",
  ledger: "Books · General ledger",
  close: "Books · Period close",
  "opening-balances": "Books · Opening balances",
  accountant: "Books · Accountant",
  cutover: "Books · Cutover",
}

export async function BooksSectionPage({
  section,
  bankAccountId,
  periodId,
}: {
  section: BooksSection
  bankAccountId?: string
  periodId?: string
}) {
  const workspace = await getBooksWorkspace()
  if (bankAccountId && !workspace.bankAccounts.some((account) => account.id === bankAccountId)) notFound()
  if (periodId && !workspace.periods.some((period) => period.id === periodId)) notFound()
  const focusedWorkspace = {
    ...workspace,
    ...(bankAccountId ? {
      bankAccounts: workspace.bankAccounts.filter((account) => account.id === bankAccountId),
      bankTransactions: workspace.bankTransactions.filter((transaction) => transaction.bank_account_id === bankAccountId),
      unmatchedTransactions: workspace.unmatchedTransactions.filter((transaction) => transaction.bank_account_id === bankAccountId),
      bankReconciliations: workspace.bankReconciliations.filter((reconciliation) => reconciliation.bank_account_id === bankAccountId),
    } : {}),
    ...(periodId ? {
      periods: workspace.periods.filter((period) => period.id === periodId),
      closeItems: workspace.closeItems.filter((item) => item.period_id === periodId),
    } : {}),
  }
  return (
    <PageLayout title={TITLES[section]} fullBleed>
      <BooksClient workspace={focusedWorkspace} section={section} />
    </PageLayout>
  )
}
