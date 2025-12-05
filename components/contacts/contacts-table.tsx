"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ContactForm } from "@/components/contacts/contact-form"
import type { Company, Contact } from "@/lib/types"
import { archiveContactAction } from "@/app/contacts/actions"
import { Filter, MoreHorizontal, Plus, Search } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

interface ContactsTableProps {
  contacts: Contact[]
  companies: Company[]
}

export function ContactsTable({ contacts, companies }: ContactsTableProps) {
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<string | undefined>()
  const [companyFilter, setCompanyFilter] = useState<string | undefined>()
  const [open, setOpen] = useState(false)
  const [selectedContact, setSelectedContact] = useState<Contact | undefined>()
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const filtered = useMemo(() => {
    return contacts
      .filter((contact) => !typeFilter || contact.contact_type === typeFilter)
      .filter((contact) => !companyFilter || contact.primary_company_id === companyFilter || contact.companies?.some((c) => c.company_id === companyFilter))
      .filter((contact) => {
        if (!search.trim()) return true
        const term = search.toLowerCase()
        return (
          contact.full_name.toLowerCase().includes(term) ||
          contact.role?.toLowerCase().includes(term) ||
          contact.email?.toLowerCase().includes(term)
        )
      })
  }, [contacts, typeFilter, companyFilter, search])

  const openEditor = (contact?: Contact) => {
    setSelectedContact(contact)
    setOpen(true)
  }

  const resetDialog = () => {
    setSelectedContact(undefined)
    setOpen(false)
  }

  const handleArchive = (contactId: string) => {
    startTransition(async () => {
      try {
        await archiveContactAction(contactId)
        router.refresh()
        toast({ title: "Contact archived" })
      } catch (error) {
        toast({ title: "Unable to archive contact", description: (error as Error).message })
      }
    })
  }

  const companyName = (id?: string) => companies.find((company) => company.id === id)?.name ?? "—"

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2 w-full md:w-auto">
          <div className="relative w-full md:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search contacts..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => openEditor(undefined)}>
              <Plus className="h-4 w-4 mr-2" />
              New contact
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{selectedContact ? "Edit contact" : "Create contact"}</DialogTitle>
              <DialogDescription>Track people you collaborate with and grant portal access.</DialogDescription>
            </DialogHeader>
            <ContactForm contact={selectedContact} companies={companies} onSubmitted={resetDialog} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Filter className="h-3 w-3" />
            Type
          </Label>
          <Select
            value={typeFilter ?? "all"}
            onValueChange={(value) => setTypeFilter(value === "all" ? undefined : value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="internal">Internal</SelectItem>
              <SelectItem value="subcontractor">Subcontractor</SelectItem>
              <SelectItem value="client">Client</SelectItem>
              <SelectItem value="vendor">Vendor</SelectItem>
              <SelectItem value="consultant">Consultant</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Filter className="h-3 w-3" />
            Company
          </Label>
          <Select
            value={companyFilter ?? "all"}
            onValueChange={(value) => setCompanyFilter(value === "all" ? undefined : value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="All companies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {companies.map((company) => (
                <SelectItem key={company.id} value={company.id}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Contacts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Portal</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((contact) => (
                <TableRow key={contact.id}>
                  <TableCell className="font-medium">{contact.full_name}</TableCell>
                  <TableCell>{companyName(contact.primary_company_id)}</TableCell>
                  <TableCell>{contact.role || "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{contact.contact_type}</Badge>
                  </TableCell>
                  <TableCell>{contact.phone || "—"}</TableCell>
                  <TableCell>{contact.email || "—"}</TableCell>
                  <TableCell>{contact.has_portal_access ? <Badge variant="secondary">Enabled</Badge> : "—"}</TableCell>
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => openEditor(contact)}>Edit</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          disabled={isPending}
                          onClick={() => handleArchive(contact.id)}
                        >
                          Archive
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                    No contacts match your filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
