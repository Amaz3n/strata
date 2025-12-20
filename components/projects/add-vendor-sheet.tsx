"use client"

import { useMemo, useTransition } from "react"
import { toast } from "sonner"

import type { Company, Contact } from "@/lib/types"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

const ROLE_OPTIONS: { label: string; value: ProjectVendorInput["role"] }[] = [
  { label: "Subcontractor", value: "subcontractor" },
  { label: "Supplier", value: "supplier" },
  { label: "Consultant", value: "consultant" },
  { label: "Architect", value: "architect" },
  { label: "Engineer", value: "engineer" },
  { label: "Client", value: "client" },
]

interface AddVendorSheetProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  contacts: Contact[]
  companies: Company[]
  onSubmit: (input: ProjectVendorInput) => Promise<void>
}

export function AddVendorSheet({ projectId, open, onOpenChange, contacts, companies, onSubmit }: AddVendorSheetProps) {
  const [isPending, startTransition] = useTransition()
  const sortedContacts = useMemo(
    () =>
      [...contacts].sort((a, b) => a.full_name.localeCompare(b.full_name)).map((contact) => ({
        ...contact,
        label: contact.role ? `${contact.full_name} • ${contact.role}` : contact.full_name,
      })),
    [contacts],
  )

  const sortedCompanies = useMemo(
    () => [...companies].sort((a, b) => a.name.localeCompare(b.name)),
    [companies],
  )

  const handleSubmit = (form: FormData) => {
    const role = form.get("role") as ProjectVendorInput["role"]
    const contactRaw = form.get("contact_id") as string
    const companyRaw = form.get("company_id") as string
    const contact_id = contactRaw && contactRaw !== "none" ? contactRaw : null
    const company_id = companyRaw && companyRaw !== "none" ? companyRaw : null
    const scope = (form.get("scope") as string) || undefined
    const notes = (form.get("notes") as string) || undefined

    if (!contact_id && !company_id) {
      toast.error("Pick a company or contact")
      return
    }

    const payload: ProjectVendorInput = {
      project_id: projectId,
      role,
      contact_id: contact_id || undefined,
      company_id: company_id || undefined,
      scope,
      notes,
    }

    startTransition(async () => {
      try {
        await onSubmit(payload)
        onOpenChange(false)
      } catch (error) {
        console.error(error)
        toast.error("Unable to add", { description: (error as Error).message })
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader className="pb-4">
          <SheetTitle>Add to directory</SheetTitle>
          <SheetDescription>Track subs, suppliers, consultants, and clients for this project.</SheetDescription>
        </SheetHeader>

        <form action={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Role</Label>
            <Select name="role" defaultValue="subcontractor">
              <SelectTrigger>
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Company</Label>
              <Select name="company_id" defaultValue="none">
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select company" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No company</SelectItem>
                  {sortedCompanies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>
                      {company.name}
                      {company.trade ? ` • ${company.trade}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Contact</Label>
              <Select name="contact_id" defaultValue="none">
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select contact" />
                </SelectTrigger>
                <SelectContent className={cn(sortedContacts.length > 10 && "max-h-80")}>
                  <SelectItem value="none">No contact</SelectItem>
                  {sortedContacts.map((contact) => (
                    <SelectItem key={contact.id} value={contact.id}>
                      {contact.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Scope on this project</Label>
            <Input name="scope" placeholder="Electrical, plumbing, cabinetry..." />
          </div>

          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea name="notes" rows={3} placeholder="Access details, crew names, gate codes..." />
          </div>

          <Button type="submit" className="w-full" disabled={isPending}>
            {isPending ? "Adding..." : "Add to project"}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  )
}
