import { notFound } from "next/navigation"
import { z } from "zod"

import { ContactAccountPage } from "@/components/contacts/contact-account-page"
import { PageLayout } from "@/components/layout/page-layout"
import { getContact, getContactAssignments } from "@/lib/services/contacts"
import { getFinancialPartyReceivables } from "@/lib/services/financial-parties"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export default async function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!z.string().uuid().safeParse(id).success) notFound()

  const contact = await getContact(id).catch(() => null)
  if (!contact) notFound()

  const [assignments, receivables, permissions] = await Promise.all([
    getContactAssignments(id),
    getFinancialPartyReceivables({ partyType: "contact", partyId: id }),
    getCurrentUserPermissions(),
  ])

  return (
    <PageLayout
      title={contact.full_name}
      breadcrumbs={[
        { label: "Directory", href: "/directory?view=people" },
        { label: contact.full_name },
      ]}
      fullBleed
    >
      <ContactAccountPage
        contact={contact}
        assignments={assignments}
        receivables={receivables}
        canEdit={permissions.permissions.includes("org.member") || permissions.permissions.includes("directory.write")}
      />
    </PageLayout>
  )
}
