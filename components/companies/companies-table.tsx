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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { archiveCompanyAction } from "@/app/companies/actions"
import type { Company, Contact, TeamMember } from "@/lib/types"
import { CompanyForm } from "@/components/companies/company-form"
import { TradeBadge } from "@/components/companies/trade-badge"
import { ContactDetailSheet } from "@/components/contacts/contact-detail-sheet"
import { DirectorySearch } from "@/components/directory/directory-search"
import { Filter, LayoutGrid, List, MoreHorizontal, Plus, Search } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

interface CompaniesTableProps {
  companies: Company[]
  contacts?: Contact[]
  teamMembers?: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
  canArchive?: boolean
}

export function CompaniesTable({
  companies,
  contacts = [],
  teamMembers = [],
  canCreate = false,
  canEdit = false,
  canArchive = false,
}: CompaniesTableProps) {
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<string | undefined>()
  const [tradeFilter, setTradeFilter] = useState<string | undefined>()
  const [view, setView] = useState<"table" | "grid">("table")
  const [open, setOpen] = useState(false)
  const [selectedCompany, setSelectedCompany] = useState<Company | undefined>()
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const [contactDetailId, setContactDetailId] = useState<string | undefined>()
  const [contactDetailOpen, setContactDetailOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  const filtered = useMemo(() => {
    return companies
      .filter((company) => !typeFilter || company.company_type === typeFilter)
      .filter((company) => !tradeFilter || company.trade === tradeFilter)
      .filter((company) => {
        if (!search.trim()) return true
        const term = search.toLowerCase()
        return company.name.toLowerCase().includes(term) || company.trade?.toLowerCase().includes(term) || company.email?.toLowerCase().includes(term)
      })
  }, [companies, search, typeFilter, tradeFilter])

  const handleArchive = (companyId: string) => {
    startTransition(async () => {
      try {
        if (!canArchive) {
          toast({
            title: "Permission required",
            description: "You need admin or member management access to archive companies.",
          })
          return
        }
        await archiveCompanyAction(companyId)
        router.refresh()
        toast({ title: "Company archived" })
      } catch (error) {
        toast({ title: "Unable to archive", description: (error as Error).message })
      }
    })
  }

  const openEditor = (company?: Company) => {
    setSelectedCompany(company)
    setOpen(true)
  }

  const openDetail = (companyId: string) => {
    router.push(`/companies/${companyId}`)
  }

  const resetDialog = () => {
    setSelectedCompany(undefined)
    setOpen(false)
  }

  const openContactDetail = (id: string) => {
    setContactDetailId(id)
    setContactDetailOpen(true)
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-2">
          <Tabs value={view} onValueChange={(value) => setView(value as "table" | "grid")}>
            <TabsList>
              <TabsTrigger value="table" className="flex items-center gap-2">
                <List className="h-4 w-4" />
                Table
              </TabsTrigger>
              <TabsTrigger value="grid" className="flex items-center gap-2">
                <LayoutGrid className="h-4 w-4" />
                Cards
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative w-full md:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-9" placeholder="Search companies..." value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>

        <Button variant="outline" onClick={() => setSearchOpen(true)}>
          <Search className="h-4 w-4 mr-2" />
          Directory search
        </Button>

        {canCreate && (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button onClick={() => openEditor(undefined)} disabled={!canCreate}>
                <Plus className="h-4 w-4 mr-2" />
                New company
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>{selectedCompany ? "Edit company" : "Create company"}</DialogTitle>
                <DialogDescription>Capture company details, trade, and insurance info.</DialogDescription>
              </DialogHeader>
              <CompanyForm company={selectedCompany} onSubmitted={resetDialog} />
            </DialogContent>
          </Dialog>
        )}
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
              <SelectItem value="subcontractor">Subcontractor</SelectItem>
              <SelectItem value="supplier">Supplier</SelectItem>
              <SelectItem value="client">Client</SelectItem>
              <SelectItem value="architect">Architect</SelectItem>
              <SelectItem value="engineer">Engineer</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Filter className="h-3 w-3" />
            Trade
          </Label>
          <Select
            value={tradeFilter ?? "all"}
            onValueChange={(value) => setTradeFilter(value === "all" ? undefined : value)}
          >
            <SelectTrigger>
              <SelectValue placeholder="All trades" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All trades</SelectItem>
              <SelectItem value="General">General</SelectItem>
              <SelectItem value="Electrical">Electrical</SelectItem>
              <SelectItem value="Plumbing">Plumbing</SelectItem>
              <SelectItem value="HVAC">HVAC</SelectItem>
              <SelectItem value="Roofing">Roofing</SelectItem>
              <SelectItem value="Framing">Framing</SelectItem>
              <SelectItem value="Concrete">Concrete</SelectItem>
              <SelectItem value="Drywall">Drywall</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {view === "table" ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Trade</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((company) => (
                  <TableRow key={company.id}>
                    <TableCell className="font-medium">{company.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{company.company_type}</Badge>
                    </TableCell>
                    <TableCell>
                      <TradeBadge trade={company.trade} />
                    </TableCell>
                    <TableCell>{company.contact_count ?? 0}</TableCell>
                    <TableCell>{company.phone || "—"}</TableCell>
                    <TableCell>{company.email || "—"}</TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => openDetail(company.id)}>View details</DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEdit} onClick={() => openEditor(company)}>
                          Edit
                        </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                          disabled={isPending || !canArchive}
                            onClick={() => handleArchive(company.id)}
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
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                      No companies match your filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((company) => (
            <Card key={company.id} className="hover:border-primary/60 transition">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between">
                  <span>{company.name}</span>
                  <Badge variant="secondary">{company.company_type}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-foreground">{company.trade || "General"}</span>
                  <TradeBadge trade={company.trade} />
                </div>
                <div className="flex items-center justify-between">
                  <span>Contacts</span>
                  <Badge variant="outline">{company.contact_count ?? 0}</Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span>{company.phone || "No phone"}</span>
                  <span>{company.email || ""}</span>
                </div>
                <div className="flex justify-end">
                  <div className="flex gap-2">
                    <Button variant="ghost" size="sm" onClick={() => openDetail(company.id)}>
                      Details
                    </Button>
                    <Button variant="ghost" size="sm" disabled={!canEdit} onClick={() => openEditor(company)}>
                      Edit
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          {filtered.length === 0 && (
            <Card className="col-span-full">
              <CardContent className="py-10 text-center text-muted-foreground">No companies found.</CardContent>
            </Card>
          )}
        </div>
      )}

      <ContactDetailSheet contactId={contactDetailId} open={contactDetailOpen} onOpenChange={setContactDetailOpen} />
      <DirectorySearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        companies={companies}
        contacts={contacts}
        teamMembers={teamMembers}
        onSelectCompany={(id) => openDetail(id)}
        onSelectContact={(id) => openContactDetail(id)}
        onSelectTeam={() => router.push("/settings?tab=team")}
      />
    </div>
  )
}
