"use client"

import { useMemo } from "react"

import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import type { Company, Contact, TeamMember } from "@/lib/types"
import { Building2, Users, User } from "@/components/icons"

type DirectoryItem =
  | { type: "company"; id: string; title: string; subtitle?: string; badge?: string }
  | { type: "contact"; id: string; title: string; subtitle?: string; badge?: string }
  | { type: "team"; id: string; title: string; subtitle?: string; badge?: string }

interface DirectorySearchProps {
  companies?: Company[]
  contacts?: Contact[]
  teamMembers?: TeamMember[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectCompany?: (id: string) => void
  onSelectContact?: (id: string) => void
  onSelectTeam?: (id: string) => void
}

export function DirectorySearch({
  companies = [],
  contacts = [],
  teamMembers = [],
  open,
  onOpenChange,
  onSelectCompany,
  onSelectContact,
  onSelectTeam,
}: DirectorySearchProps) {
  const items: DirectoryItem[] = useMemo(() => {
    const companyItems: DirectoryItem[] = companies.map((c) => ({
      type: "company",
      id: c.id,
      title: c.name,
      subtitle: c.trade || c.company_type,
      badge: c.company_type,
    }))
    const contactItems: DirectoryItem[] = contacts.map((c) => ({
      type: "contact",
      id: c.id,
      title: c.full_name,
      subtitle: c.primary_company?.name ?? c.role ?? c.contact_type,
      badge: c.contact_type,
    }))
    const teamItems: DirectoryItem[] = teamMembers.map((m) => ({
      type: "team",
      id: m.id,
      title: m.user.full_name ?? m.user.email,
      subtitle: m.role,
      badge: m.status,
    }))
    return [...companyItems, ...contactItems, ...teamItems]
  }, [companies, contacts, teamMembers])

  const handleSelect = (item: DirectoryItem) => {
    if (item.type === "company") onSelectCompany?.(item.id)
    if (item.type === "contact") onSelectContact?.(item.id)
    if (item.type === "team") onSelectTeam?.(item.id)
    onOpenChange(false)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Directory search" description="Search contacts, companies, team">
      <CommandInput placeholder="Search directory..." />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Companies">
          {items
            .filter((i) => i.type === "company")
            .map((item) => (
              <CommandItem key={item.id} value={`${item.title} ${item.subtitle ?? ""}`} onSelect={() => handleSelect(item)}>
                <Building2 className="h-4 w-4" />
                <span className="flex-1">{item.title}</span>
                <span className="text-xs text-muted-foreground">{item.subtitle}</span>
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandGroup heading="Contacts">
          {items
            .filter((i) => i.type === "contact")
            .map((item) => (
              <CommandItem key={item.id} value={`${item.title} ${item.subtitle ?? ""}`} onSelect={() => handleSelect(item)}>
                <User className="h-4 w-4" />
                <span className="flex-1">{item.title}</span>
                <span className="text-xs text-muted-foreground">{item.subtitle}</span>
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandGroup heading="Team">
          {items
            .filter((i) => i.type === "team")
            .map((item) => (
              <CommandItem key={item.id} value={`${item.title} ${item.subtitle ?? ""}`} onSelect={() => handleSelect(item)}>
                <Users className="h-4 w-4" />
                <span className="flex-1">{item.title}</span>
                <span className="text-xs text-muted-foreground">{item.subtitle}</span>
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}


