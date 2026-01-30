"use client"

import { useMemo, useState, type CSSProperties } from "react"
import { useRouter } from "next/navigation"

import type { Company, Contact } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { CompanyForm } from "@/components/companies/company-form"
import { ContactForm } from "@/components/contacts/contact-form"
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet"
import { DirectoryTable } from "@/components/directory/directory-table"
import { Building2, ChevronDown, Plus, Search, User } from "@/components/icons"

interface DirectoryClientProps {
  companies: Company[]
  contacts: Contact[]
  canCreate: boolean
  initialView?: "all" | "companies" | "people"
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
  const [detailContactId, setDetailContactId] = useState<string | undefined>()
  const [detailContactOpen, setDetailContactOpen] = useState(false)

  const openCompanyDetail = (id: string) => {
    router.push(`/companies/${id}`)
  }

  const openContactDetail = (id: string) => {
    setDetailContactId(id)
    setDetailContactOpen(true)
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

  const openNewContact = () => {
    setSelectedContact(undefined)
    setContactDialogOpen(true)
  }

  const viewLabel = view === "all" ? "All" : view === "companies" ? "Companies" : "People"

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex w-full flex-col gap-2">
          <div className="flex w-full max-w-sm items-center gap-2 rounded-md border bg-background px-2 py-1 shadow-sm">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search companies and contacts..."
              className="h-8 border-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8 gap-1 px-2">
                  {viewLabel}
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem onSelect={() => setView("all")}>All</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setView("companies")}>Companies</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setView("people")}>People</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {canCreate && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" className="h-10 w-10">
                <Plus className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => openNewCompany()}>
                Add company
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openNewContact()}>
                Add contact
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <DirectoryTable
        companies={filteredCompanies}
        contacts={filteredContacts}
        search={searchTerm}
        onSelectCompany={openCompanyDetail}
        onSelectContact={openContactDetail}
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
          if (!open) setSelectedContact(undefined)
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
              contact={selectedContact}
              companies={companies}
              onSubmitted={() => setContactDialogOpen(false)}
              onCancel={() => setContactDialogOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <ContactDetailSheet contactId={detailContactId} open={detailContactOpen} onOpenChange={setDetailContactOpen} />
    </div>
  )
}
