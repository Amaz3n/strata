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
import type { Company } from "@/lib/types"
import { createCompanyAction, updateCompanyAction } from "@/app/companies/actions"
import { useToast } from "@/hooks/use-toast"

const COMPANY_TYPES: { label: string; value: Company["company_type"] }[] = [
  { label: "Subcontractor", value: "subcontractor" },
  { label: "Supplier", value: "supplier" },
  { label: "Client", value: "client" },
  { label: "Architect", value: "architect" },
  { label: "Engineer", value: "engineer" },
  { label: "Other", value: "other" },
]

const TRADES = [
  "General",
  "Electrical",
  "Plumbing",
  "HVAC",
  "Roofing",
  "Framing",
  "Drywall",
  "Painting",
  "Flooring",
  "Concrete",
  "Masonry",
  "Landscaping",
  "Pool",
  "Fencing",
  "Windows/Doors",
  "Cabinets",
  "Countertops",
  "Tile",
  "Insulation",
  "Stucco",
] as const

interface CompanyFormProps {
  company?: Company
  onSubmitted?: () => void
}

export function CompanyForm({ company, onSubmitted }: CompanyFormProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const [formState, setFormState] = useState({
    name: company?.name ?? "",
    company_type: company?.company_type ?? "subcontractor",
    trade: company?.trade ?? "none",
    phone: company?.phone ?? "",
    email: company?.email ?? "",
    website: company?.website ?? "",
    license_number: company?.license_number ?? "",
    insurance_expiry: company?.insurance_expiry ?? "",
    notes: company?.notes ?? "",
    address: {
      street1: company?.address?.street1 ?? "",
      street2: company?.address?.street2 ?? "",
      city: company?.address?.city ?? "",
      state: company?.address?.state ?? "",
      postal_code: company?.address?.postal_code ?? "",
    },
  })

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const payload = {
      ...formState,
      trade: formState.trade === "none" ? undefined : formState.trade,
      phone: formState.phone || undefined,
      email: formState.email || undefined,
      website: formState.website || undefined,
      license_number: formState.license_number || undefined,
      insurance_expiry: formState.insurance_expiry || undefined,
      notes: formState.notes || undefined,
      address: {
        street1: formState.address.street1 || undefined,
        street2: formState.address.street2 || undefined,
        city: formState.address.city || undefined,
        state: formState.address.state || undefined,
        postal_code: formState.address.postal_code || undefined,
      },
    }

    startTransition(async () => {
      try {
        if (company) {
          await updateCompanyAction(company.id, payload)
        } else {
          await createCompanyAction(payload)
        }
        router.refresh()
        toast({ title: company ? "Company updated" : "Company created" })
        onSubmitted?.()
      } catch (error) {
        console.error(error)
        toast({ title: "Unable to save company", description: (error as Error).message })
      }
    })
  }

  const setField = (key: string, value: string) => {
    setFormState((prev) => ({ ...prev, [key]: value }))
  }

  const setAddressField = (key: string, value: string) => {
    setFormState((prev) => ({ ...prev, address: { ...prev.address, [key]: value } }))
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={formState.name}
            onChange={(e) => setField("name", e.target.value)}
            required
            placeholder="ABC Plumbing LLC"
          />
        </div>
        <div className="space-y-2">
          <Label>Type</Label>
          <Select value={formState.company_type} onValueChange={(value) => setField("company_type", value)}>
            <SelectTrigger>
              <SelectValue placeholder="Select type" />
            </SelectTrigger>
            <SelectContent>
              {COMPANY_TYPES.map((type) => (
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
          <Label>Trade</Label>
          <Select value={formState.trade} onValueChange={(value) => setField("trade", value)}>
            <SelectTrigger>
              <SelectValue placeholder="Select trade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No trade</SelectItem>
              {TRADES.map((trade) => (
                <SelectItem key={trade} value={trade}>
                  {trade}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Phone</Label>
          <Input value={formState.phone} onChange={(e) => setField("phone", e.target.value)} placeholder="(555) 123-4567" />
        </div>
        <div className="space-y-2">
          <Label>Email</Label>
          <Input type="email" value={formState.email} onChange={(e) => setField("email", e.target.value)} placeholder="office@abc.com" />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Website</Label>
          <Input value={formState.website} onChange={(e) => setField("website", e.target.value)} placeholder="https://abc.com" />
        </div>
        <div className="space-y-2">
          <Label>License #</Label>
          <Input value={formState.license_number} onChange={(e) => setField("license_number", e.target.value)} placeholder="LIC-1234" />
        </div>
        <div className="space-y-2">
          <Label>Insurance expiry</Label>
          <Input type="date" value={formState.insurance_expiry} onChange={(e) => setField("insurance_expiry", e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <Label>Street</Label>
          <Input value={formState.address.street1} onChange={(e) => setAddressField("street1", e.target.value)} placeholder="123 Main St" />
        </div>
        <div className="space-y-2">
          <Label>City</Label>
          <Input value={formState.address.city} onChange={(e) => setAddressField("city", e.target.value)} placeholder="Austin" />
        </div>
        <div className="space-y-2">
          <Label>State / Zip</Label>
          <div className="flex gap-2">
            <Input value={formState.address.state} onChange={(e) => setAddressField("state", e.target.value)} placeholder="TX" className="w-24" />
            <Input value={formState.address.postal_code} onChange={(e) => setAddressField("postal_code", e.target.value)} placeholder="78701" />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Label>Notes</Label>
        <Textarea value={formState.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="Insurance carrier, crew size, specialties..." />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : company ? "Update company" : "Create company"}
        </Button>
      </div>
    </form>
  )
}
