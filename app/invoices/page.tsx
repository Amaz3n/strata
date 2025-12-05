import { AppShell } from "@/components/layout/app-shell"
import { InvoicesClient } from "@/components/invoices/invoices-client"
import { listInvoicesAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

export default async function InvoicesPage() {
  const [invoices, projects, currentUser] = await Promise.all([
    listInvoicesAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  return (
    <AppShell title="Invoices" user={currentUser}>
      <div className="p-4 lg:p-6">
        <InvoicesClient invoices={invoices} projects={projects} />
      </div>
    </AppShell>
  )
}

