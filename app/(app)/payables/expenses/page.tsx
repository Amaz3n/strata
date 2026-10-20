import { Suspense } from "react"
import { connection } from "next/server"

import { OrgExpenseDesk } from "@/components/expenses/org-expense-desk"
import { PageLayout } from "@/components/layout/page-layout"
import { loadOrgExpenseDesk } from "@/lib/services/org-expenses"
import { ORG_EXPENSE_QUEUES } from "@/lib/validation/org-expenses"
import LoadingExpenses from "./loading"

async function ExpensesPageContent({ searchParams }: { searchParams: Promise<{ queue?: string }> }) {
  await connection()
  const { queue } = await searchParams
  const desk = await loadOrgExpenseDesk({ queue: ORG_EXPENSE_QUEUES.find((value) => value === queue) ?? "review" })

  return (
    <PageLayout title="Expenses" fullBleed>
      <OrgExpenseDesk desk={desk} />
    </PageLayout>
  )
}

export default function ExpensesPage(props: Parameters<typeof ExpensesPageContent>[0]) {
  return (
    <Suspense fallback={<PageLayout title="Expenses" fullBleed><LoadingExpenses /></PageLayout>}>
      <ExpensesPageContent {...props} />
    </Suspense>
  )
}
