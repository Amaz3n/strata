"use client"

import { useMemo, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"

import type { Company, Contact } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CompanyForm } from "@/components/companies/company-form"
import { ContactForm } from "@/components/contacts/contact-form"
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet"
import { DirectoryTable } from "@/components/directory/directory-table"
import { Building2, Plus, Search, User } from "@/components/icons"

interface DirectoryClientProps {
  companies: Company[]
  contacts: Contact[]
  canCreate: boolean
  initialView?: "all" | "companies" | "people"
}

function SummaryCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="border-r border-b bg-background p-4 last:border-r-0">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
    </div>
  )
}

export function DirectoryClient({
  companies,
  contacts,
  canCreate,
  initialView = "all",
}: DirectoryClientProps) {
  const router = useRouter()
  const standaloneContacts = useMemo(
    () => contacts.filter((c) => !c.primary_company_id && !(c.companies && c.companies.length > 0)),
    [contacts],
  )

  const [searchTerm, setSearchTerm] = useState("")
  const [view, setView] = useState<"all" | "companies" | "people">(initialView)
  const [companyDialogOpen, setCompanyDialogOpen] = useState(false)
  const [contactDialogOpen, setContactDialogOpen] = useState(false)
  const [selectedCompany, setSelectedCompany] = useState<Company | undefined>()
  const [selectedContact, setSelectedContact] = useState<Contact | undefined>()
  const [newContactCompanyId, setNewContactCompanyId] = useState<string | undefined>()
  const [detailContactId, setDetailContactId] = useState<string | undefined>()
  const [detailContactOpen, setDetailContactOpen] = useState(false)

  const counts = useMemo(() => {
    const byType: Record<string, number> = {}
    for (const c of companies) {
      byType[c.company_type] = (byType[c.company_type] ?? 0) + 1
    }
    const otherTypes = (byType["architect"] ?? 0) + (byType["engineer"] ?? 0) + (byType["other"] ?? 0)
    return {
      companies: companies.length,
      people: contacts.length,
      subs: byType["subcontractor"] ?? 0,
      suppliers: byType["supplier"] ?? 0,
      clients: byType["client"] ?? 0,
      other: otherTypes,
    }
  }, [companies, contacts])

  const openCompanyDetail = (id: string) => {
    router.push(`/companies/${id}`)
  }

  const openContactDetail = (id: string) => {
    setDetailContactId(id)
    setDetailContactOpen(true)
  }

  const openEditContact = (contact: Contact) => {
    setNewContactCompanyId(undefined)
    setSelectedContact(contact)
    setDetailContactOpen(false)
    setContactDialogOpen(true)
  }

  const filteredCompanies = useMemo(() => (view === "people" ? [] : companies), [companies, view])
  const filteredContacts = useMemo(
    () => (view === "companies" ? [] : view === "people" ? contacts : standaloneContacts),
    [contacts, standaloneContacts, view],
  )

  const openNewCompany = () => {
    setSelectedCompany(undefined)
    setCompanyDialogOpen(true)
  }

  const openNewContact = (companyId?: string) => {
    setNewContactCompanyId(companyId)
    setSelectedContact(undefined)
    setContactDialogOpen(true)
  }

  const contactFormKey = selectedContact?.id
    ? `edit-${selectedContact.id}`
    : `new-${newContactCompanyId ?? "none"}-${contactDialogOpen ? "open" : "closed"}`

  return (
    <div className="flex min-h-full flex-col bg-background">
      <div className="grid border-t sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <SummaryCard label="Companies" value={counts.companies} />
        <SummaryCard label="People" value={counts.people} />
        <SummaryCard label="Subcontractors" value={counts.subs} />
        <SummaryCard label="Suppliers" value={counts.suppliers} />
        <SummaryCard label="Clients" value={counts.clients} />
        <SummaryCard label="Other" value={counts.other} />
      </div>

      <div className="flex shrink-0 flex-col gap-3 border-b bg-background/95 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="companies">Companies</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search companies and contacts"
              className="h-9 pl-8"
            />
          </div>

          {canCreate && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="default" className="h-9 w-9">
                  <Plus className="h-4 w-4" />
                  <span className="sr-only">Add</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => openNewCompany()}>Add company</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openNewContact()}>Add contact</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <DirectoryTable
        companies={filteredCompanies}
        contacts={filteredContacts}
        search={searchTerm}
        onSelectCompany={openCompanyDetail}
        onSelectContact={openContactDetail}
        onAddContactForCompany={canCreate ? openNewContact : undefined}
      />

      <Sheet
        open={companyDialogOpen}
        onOpenChange={(open) => {
          setCompanyDialogOpen(open)
          if (!open) setSelectedCompany(undefined)
        }}
      >
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              {selectedCompany ? "Edit company" : "Create company"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Capture company details, trade, and insurance info.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 px-6 py-4">
            <CompanyForm
              company={selectedCompany}
              onSubmitted={() => setCompanyDialogOpen(false)}
              onCancel={() => setCompanyDialogOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet
        open={contactDialogOpen}
        onOpenChange={(open) => {
          setContactDialogOpen(open)
          if (!open) {
            setSelectedContact(undefined)
            setNewContactCompanyId(undefined)
          }
        }}
      >
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle className="flex items-center gap-2">
              <User className="h-4 w-4 text-primary" />
              {selectedContact ? "Edit contact" : "Create contact"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Add a person and optionally link them to a company.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 px-6 py-4">
            <ContactForm
              key={contactFormKey}
              contact={selectedContact}
              companies={companies}
              defaultPrimaryCompanyId={newContactCompanyId}
              onSubmitted={() => setContactDialogOpen(false)}
              onCancel={() => setContactDialogOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ContactDetailSheet
        contactId={detailContactId}
        open={detailContactOpen}
        onOpenChange={setDetailContactOpen}
        onEditContact={openEditContact}
      />
    </div>
  )
}
