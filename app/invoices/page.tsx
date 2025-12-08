import { AppShell } from "@/components/layout/app-shell"
import { InvoicesClient } from "@/components/invoices/invoices-client"
import { listInvoicesAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"
import { getOrgBilling } from "@/lib/services/orgs"
import { listContactsAction } from "@/app/contacts/actions"
import type { Address, CostCode } from "@/lib/types"
import { listCostCodes } from "@/lib/services/cost-codes"

export default async function InvoicesPage() {
  const [invoices, projects, currentUser, orgBilling, contacts, costCodes] = await Promise.all([
    listInvoicesAction(),
    listProjectsAction(),
    getCurrentUserAction(),
    getOrgBilling(),
    listContactsAction(),
    listCostCodes(),
  ])

  return (
    <AppShell title="Invoices" user={currentUser}>
      <div className="p-4 lg:p-6">
        <InvoicesClient
          invoices={invoices}
          projects={projects}
          builderInfo={{
            name: orgBilling?.org?.name,
            email: orgBilling?.org?.billing_email,
            address: formatAddress(orgBilling?.org?.address as Address | undefined),
          }}
          contacts={contacts}
          costCodes={costCodes as CostCode[]}
        />
      </div>
    </AppShell>
  )
}

function formatAddress(address?: Address) {
  if (!address) return undefined
  const parts = [
    address.formatted,
    [address.street1, address.street2].filter(Boolean).join(" "),
    [address.city, address.state].filter(Boolean).join(", "),
    address.postal_code,
    address.country,
  ]
    .map((part) => part?.trim())
    .filter((part) => !!part && part.length > 0)

  return parts.join("\n")
}

