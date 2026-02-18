"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { Company, Contact } from "@/lib/types"
import { createContactAction, updateContactAction } from "@/app/(app)/contacts/actions"
import { useToast } from "@/hooks/use-toast"

const CONTACT_TYPES: { label: string; value: Contact["contact_type"] }[] = [
  { label: "Internal", value: "internal" },
  { label: "Subcontractor", value: "subcontractor" },
  { label: "Client", value: "client" },
  { label: "Vendor", value: "vendor" },
  { label: "Consultant", value: "consultant" },
]

interface ContactFormProps {
  contact?: Contact
  companies?: Company[]
  onSubmitted?: () => void
  onCancel?: () => void
}

export function ContactForm({ contact, companies = [], onSubmitted, onCancel }: ContactFormProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const [formState, setFormState] = useState({
    full_name: contact?.full_name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    address: contact?.address?.formatted ?? "",
    role: contact?.role ?? "",
    contact_type: contact?.contact_type ?? "subcontractor",
    primary_company_id: contact?.primary_company_id ?? "none",
    has_portal_access: contact?.has_portal_access ?? false,
    notes: contact?.notes ?? "",
    preferred_contact_method: contact?.preferred_contact_method ?? "none",
    external_crm_id: contact?.external_crm_id ?? "",
    crm_source: contact?.crm_source ?? "",
  })

  const setField = (key: string, value: string | boolean) => {
    setFormState((prev) => ({ ...prev, [key]: value }))
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const payload = {
      ...formState,
      email: formState.email || undefined,
      phone: formState.phone || undefined,
      address: formState.address || undefined,
      role: formState.role || undefined,
      primary_company_id: formState.primary_company_id === "none" ? undefined : formState.primary_company_id,
      preferred_contact_method: formState.preferred_contact_method === "none" ? undefined : formState.preferred_contact_method,
      notes: formState.notes || undefined,
      external_crm_id: formState.external_crm_id || undefined,
      crm_source: formState.crm_source || undefined,
    }

    startTransition(async () => {
      try {
        if (contact) {
          await updateContactAction(contact.id, payload)
        } else {
          await createContactAction(payload)
        }
        router.refresh()
        toast({ title: contact ? "Contact updated" : "Contact created" })
        onSubmitted?.()
      } catch (error) {
        console.error(error)
        toast({ title: "Unable to save contact", description: (error as Error).message })
      }
    })
  }

  return (
    <form className="flex h-full flex-col" onSubmit={handleSubmit}>
      <div className="flex-1 space-y-5 overflow-y-auto pr-1">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={formState.full_name} onChange={(e) => setField("full_name", e.target.value)} required placeholder="Jane Doe" />
          </div>
        <div className="space-y-2">
          <Label>Type</Label>
          <Select value={formState.contact_type} onValueChange={(value) => setField("contact_type", value)}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_TYPES.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Email</Label>
          <Input type="email" value={formState.email} onChange={(e) => setField("email", e.target.value)} placeholder="jane@abc.com" />
        </div>
        <div className="space-y-2">
          <Label>Phone</Label>
          <Input value={formState.phone} onChange={(e) => setField("phone", e.target.value)} placeholder="(555) 555-5555" />
        </div>
        <div className="space-y-2">
          <Label>Role</Label>
          <Input value={formState.role} onChange={(e) => setField("role", e.target.value)} placeholder="Project Manager" />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Billing address</Label>
        <Textarea
          value={formState.address}
          onChange={(e) => setField("address", e.target.value)}
          placeholder={"123 Main St\nNaples, FL 34102"}
          rows={3}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Primary company</Label>
          <Select
            value={formState.primary_company_id}
            onValueChange={(value) => setField("primary_company_id", value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select company" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              {companies.map((company) => (
                <SelectItem key={company.id} value={company.id}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Preferred contact method</Label>
          <Select
            value={formState.preferred_contact_method}
            onValueChange={(value) => setField("preferred_contact_method", value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No preference</SelectItem>
              <SelectItem value="phone">Phone</SelectItem>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="text">Text</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="portal-access"
          checked={formState.has_portal_access}
          onCheckedChange={(checked) => setField("has_portal_access", checked)}
        />
        <Label htmlFor="portal-access">Grant portal access</Label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>CRM source</Label>
          <Input value={formState.crm_source} onChange={(e) => setField("crm_source", e.target.value)} placeholder="Salesforce" />
        </div>
        <div className="space-y-2">
          <Label>External CRM ID</Label>
          <Input value={formState.external_crm_id} onChange={(e) => setField("external_crm_id", e.target.value)} placeholder="003..."/>
        </div>
      </div>

        <div className="space-y-2">
          <Label>Notes</Label>
          <Textarea value={formState.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="Crew members, gate codes, preferences..." />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : contact ? "Update contact" : "Create contact"}
        </Button>
      </div>
    </form>
  )
}


