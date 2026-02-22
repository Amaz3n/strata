"use client"

import { useMemo, useState, useTransition } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Company, Contact } from "@/lib/types"
import { getCompanyContactsForDirectoryAction } from "@/app/(app)/directory/actions"
import { Building2, ChevronDown, ChevronRight, User, Loader2, Plus } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

type DirectoryItem =
  | { type: "company"; id: string; name: string; company_type?: string; trade?: string; contact_count?: number }
  | { type: "contact"; id: string; name: string; role?: string; contact_type?: string }

interface DirectoryTableProps {
  companies: Company[]
  contacts: Contact[]
  search: string
  onSelectCompany?: (id: string) => void
  onSelectContact?: (id: string) => void
  onAddContactForCompany?: (companyId: string) => void
}

export function DirectoryTable({
  companies,
  contacts,
  search,
  onSelectCompany,
  onSelectContact,
  onAddContactForCompany,
}: DirectoryTableProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [loadingCompany, setLoadingCompany] = useState<string | null>(null)
  const [companyContacts, setCompanyContacts] = useState<Record<string, Contact[]>>({})
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  const items: DirectoryItem[] = useMemo(() => {
    const companyItems: DirectoryItem[] = companies.map((c) => ({
      type: "company",
      id: c.id,
      name: c.name,
      company_type: c.company_type,
      trade: c.trade,
      contact_count: c.contact_count,
    }))
    const contactItems: DirectoryItem[] = contacts.map((c) => ({
      type: "contact",
      id: c.id,
      name: c.full_name,
      role: c.role,
      contact_type: c.contact_type,
    }))
    const combined = [...companyItems, ...contactItems]
    if (!search.trim()) return combined
    const term = search.toLowerCase()
    return combined.filter((item) => item.name.toLowerCase().includes(term))
  }, [companies, contacts, search])

  const toggleExpand = (companyId: string) => {
    const next = !expanded[companyId]
    setExpanded((prev) => ({ ...prev, [companyId]: next }))
    if (next && !companyContacts[companyId]) {
      setLoadingCompany(companyId)
      startTransition(async () => {
        try {
          const contacts = await getCompanyContactsForDirectoryAction(companyId)
          setCompanyContacts((prev) => ({ ...prev, [companyId]: contacts }))
        } catch (error) {
          toast({ title: "Unable to load contacts", description: (error as Error).message })
          setExpanded((prev) => ({ ...prev, [companyId]: false }))
        } finally {
          setLoadingCompany(null)
        }
      })
    }
  }

  return (
    <div className="rounded-lg border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="divide-x">
            <TableHead className="px-4 py-3">Name</TableHead>
            <TableHead className="px-4 py-3">Type</TableHead>
            <TableHead className="px-4 py-3">Detail</TableHead>
            <TableHead className="w-12 px-4 py-3" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) =>
            item.type === "company" ? (
              <CompanyRow
                key={item.id}
                item={item}
                expanded={!!expanded[item.id]}
                contacts={companyContacts[item.id]}
                loading={loadingCompany === item.id && isPending}
                onToggle={() => toggleExpand(item.id)}
                onSelectCompany={onSelectCompany}
                onSelectContact={onSelectContact}
                onAddContactForCompany={onAddContactForCompany}
              />
            ) : (
              <ContactRow key={item.id} item={item} onSelectContact={onSelectContact} />
            ),
          )}
          {items.length === 0 && (
            <TableRow className="divide-x">
              <TableCell colSpan={4} className="text-center text-muted-foreground py-10">
                No directory results match your filters.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

function CompanyRow({
  item,
  expanded,
  contacts,
  loading,
  onToggle,
  onSelectCompany,
  onSelectContact,
  onAddContactForCompany,
}: {
  item: Extract<DirectoryItem, { type: "company" }>
  expanded: boolean
  contacts?: Contact[]
  loading: boolean
  onToggle: () => void
  onSelectCompany?: (id: string) => void
  onSelectContact?: (id: string) => void
  onAddContactForCompany?: (companyId: string) => void
}) {
  return (
    <>
      <TableRow
        className="divide-x align-top hover:bg-muted/40 cursor-pointer"
        onClick={() => onSelectCompany?.(item.id)}
      >
        <TableCell className="font-medium px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={(e) => {
                e.stopPropagation()
                onToggle()
              }}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span>{item.name}</span>
          </div>
        </TableCell>
        <TableCell className="px-4 py-3">
          <Badge variant="secondary">{item.company_type ?? "Company"}</Badge>
        </TableCell>
        <TableCell className="px-4 py-3 text-sm text-muted-foreground">{item.trade || "—"}</TableCell>
        <TableCell className="px-4 py-3 text-right text-muted-foreground" />
      </TableRow>
      {expanded && (
        <TableRow className="divide-x bg-muted/30">
          <TableCell colSpan={4} className="px-4 py-4">
            {onAddContactForCompany ? (
              <div className="mb-3 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onAddContactForCompany(item.id)}
                  className="h-8 gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add contact
                </Button>
              </div>
            ) : null}
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading contacts...
              </div>
            ) : contacts && contacts.length > 0 ? (
              <div className="space-y-2">
                {contacts.map((contact) => (
                  <button
                    key={contact.id}
                    type="button"
                    onClick={() => onSelectContact?.(contact.id)}
                    className="flex w-full items-center justify-between rounded-md border bg-background px-3 py-2 text-left transition hover:border-primary/50 hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium text-foreground">{contact.full_name}</div>
                        <div className="text-xs text-muted-foreground">
                          {contact.role ?? contact.contact_type ?? "Contact"}
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground py-1">No contacts for this company.</div>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function ContactRow({
  item,
  onSelectContact,
}: {
  item: Extract<DirectoryItem, { type: "contact" }>
  onSelectContact?: (id: string) => void
}) {
  return (
    <TableRow
      className="divide-x align-top hover:bg-muted/40 cursor-pointer"
      onClick={() => onSelectContact?.(item.id)}
    >
      <TableCell className="font-medium px-4 py-3">
        <div className="flex items-center gap-2">
          <User className="h-4 w-4 text-muted-foreground" />
          <span>{item.name}</span>
        </div>
      </TableCell>
      <TableCell className="px-4 py-3">
        <Badge variant="secondary">{item.contact_type ?? "Contact"}</Badge>
      </TableCell>
      <TableCell className="px-4 py-3 text-sm text-muted-foreground">{item.role || "—"}</TableCell>
      <TableCell className="px-4 py-3 text-right text-muted-foreground" />
    </TableRow>
  )
}
