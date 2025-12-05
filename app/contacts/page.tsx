import { AppShell } from "@/components/layout/app-shell"
import { getCurrentUserAction } from "@/app/actions/user"
import { listContacts } from "@/lib/services/contacts"
import { listCompanies } from "@/lib/services/companies"
import { ContactsTable } from "@/components/contacts/contacts-table"

export default async function ContactsPage() {
  const [contacts, companies, currentUser] = await Promise.all([listContacts(), listCompanies(), getCurrentUserAction()])

  return (
    <AppShell title="Contacts" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Contacts</h1>
          <p className="text-muted-foreground mt-1">People you collaborate with across projects and companies.</p>
        </div>
        <ContactsTable contacts={contacts} companies={companies} />
      </div>
    </AppShell>
  )
}

