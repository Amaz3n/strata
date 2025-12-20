"use client"

import { useMemo, useState } from "react"

import type { Company, Contact, ProjectVendor } from "@/lib/types"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"
import { Button } from "@/components/ui/button"
import { AddVendorSheet } from "@/components/projects/add-vendor-sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Building2, Mail, Phone } from "@/components/icons"
import { MoreHorizontal } from "lucide-react"

export const DIRECTORY_ROLE_FILTERS: { label: string; value: "all" | ProjectVendorInput["role"] }[] = [
  { label: "All", value: "all" },
  { label: "Subcontractors", value: "subcontractor" },
  { label: "Suppliers", value: "supplier" },
  { label: "Consultants", value: "consultant" },
  { label: "Architects", value: "architect" },
  { label: "Engineers", value: "engineer" },
  { label: "Clients", value: "client" },
]

interface ProjectDirectoryProps {
  projectId: string
  vendors: ProjectVendor[]
  contacts: Contact[]
  companies: Company[]
  loading?: boolean
  search?: string
  onSearchChange?: (value: string) => void
  roleFilter?: "all" | ProjectVendorInput["role"]
  onRoleFilterChange?: (value: "all" | ProjectVendorInput["role"]) => void
  addOpen?: boolean
  onAddOpenChange?: (open: boolean) => void
  hideHeader?: boolean
  onAdd: (input: ProjectVendorInput) => Promise<void>
  onRemove: (vendorId: string) => Promise<void>
  onUpdate: (vendorId: string, updates: Partial<Pick<ProjectVendorInput, "role" | "scope" | "notes">>) => Promise<void>
}

export function ProjectDirectory({
  projectId,
  vendors,
  contacts,
  companies,
  loading,
  search: externalSearch,
  roleFilter: externalRoleFilter,
  addOpen,
  onAddOpenChange,
  hideHeader = false,
  onAdd,
  onRemove,
  onUpdate: _onUpdate,
}: ProjectDirectoryProps) {
  const [addOpenState, setAddOpenState] = useState(false)

  const resolvedRoleFilter = externalRoleFilter ?? "all"
  const resolvedSearch = externalSearch ?? ""

  const addSheetOpen = addOpen ?? addOpenState
  const handleAddOpenChange = onAddOpenChange ?? setAddOpenState

  const filteredVendors = useMemo(
    () =>
      vendors.filter((vendor) => {
        const matchesRole = resolvedRoleFilter === "all" || vendor.role === resolvedRoleFilter
        const haystack = [
          vendor.company?.name,
          vendor.company?.trade,
          vendor.contact?.full_name,
          vendor.contact?.email,
          vendor.scope,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()

        const matchesSearch = haystack.includes(resolvedSearch.toLowerCase())
        return matchesRole && matchesSearch
      }),
    [vendors, resolvedRoleFilter, resolvedSearch],
  )

  return (
    <div className="flex-1 flex flex-col gap-4">
      <AddVendorSheet
        projectId={projectId}
        open={addSheetOpen}
        onOpenChange={handleAddOpenChange}
        contacts={contacts}
        companies={companies}
        onSubmit={onAdd}
      />

      {!hideHeader && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Directory</h3>
            <p className="text-sm text-muted-foreground">Subs, suppliers, consultants, and clients linked to this job.</p>
          </div>
        </div>
      )}

      <div className="rounded-lg border overflow-hidden">
        <div className="overflow-x-auto">
          <Table className="min-w-[820px]">
            <TableHeader>
              <TableRow className="divide-x">
                <TableHead className="px-4 py-3">Directory entry</TableHead>
                <TableHead className="px-4 py-3">Trade</TableHead>
                <TableHead className="px-4 py-3">Contact</TableHead>
                <TableHead className="px-4 py-3">Email</TableHead>
                <TableHead className="px-4 py-3">Phone</TableHead>
                <TableHead className="px-4 py-3 text-right w-24">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredVendors.map((vendor) => (
                <TableRow key={vendor.id} className="divide-x align-top hover:bg-muted/40">
                  <TableCell className="px-4 py-3 align-top">
                    <div className="flex flex-col gap-1">
                      <div className="font-medium">{vendor.company?.name ?? vendor.contact?.full_name ?? "Unknown"}</div>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top text-sm text-muted-foreground">
                    {vendor.company?.trade ?? "—"}
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    {vendor.contact?.full_name ? (
                      <div className="flex items-center gap-2 text-sm">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span>{vendor.contact.full_name}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    {vendor.contact?.email ? (
                      <a
                        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                        href={`mailto:${vendor.contact.email}`}
                      >
                        <Mail className="h-4 w-4" />
                        <span className="truncate">{vendor.contact.email}</span>
                      </a>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    {vendor.contact?.phone ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Phone className="h-4 w-4" />
                        <span>{vendor.contact.phone}</span>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 align-top">
                    <div className="flex justify-center">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-destructive"
                            disabled={loading}
                            onClick={() => onRemove(vendor.id)}
                          >
                            Remove
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))}

              {filteredVendors.length === 0 && (
                <TableRow className="divide-x">
                  <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                    No companies or contacts match this view.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
