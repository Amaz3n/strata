"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { Company } from "@/lib/types"
import { createCompanyAction, updateCompanyAction } from "@/app/(app)/companies/actions"
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
  onCancel?: () => void
}

export function CompanyForm({ company, onSubmitted, onCancel }: CompanyFormProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const allowedTypes = new Set(COMPANY_TYPES.map((type) => type.value))
  const fallbackTrade = company?.trade ?? (company && !allowedTypes.has(company.company_type) ? company.company_type : undefined)

  const [formState, setFormState] = useState({
    name: company?.name ?? "",
    company_type: (company?.company_type && allowedTypes.has(company.company_type)) ? company.company_type : "subcontractor",
    trade: fallbackTrade ?? "none",
    phone: company?.phone ?? "",
    email: company?.email ?? "",
    website: company?.website ?? "",
    license_number: company?.license_number ?? "",
    license_expiry: company?.license_expiry ?? "",
    license_verified: company?.license_verified ?? false,
    insurance_expiry: company?.insurance_expiry ?? "",
    insurance_provider: company?.insurance_provider ?? "",
    w9_on_file: company?.w9_on_file ?? false,
    prequalified: company?.prequalified ?? false,
    rating: company?.rating ? String(company.rating) : "none",
    default_payment_terms: company?.default_payment_terms ?? "",
    internal_notes: company?.internal_notes ?? "",
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
    const rawWebsite = formState.website.trim()
    const normalizedWebsite = rawWebsite
      ? (/^https?:\/\//i.test(rawWebsite) ? rawWebsite : `https://${rawWebsite}`)
      : ""
    const payload = {
      ...formState,
      trade: formState.trade === "none" ? undefined : formState.trade,
      phone: formState.phone || undefined,
      email: formState.email || undefined,
      website: normalizedWebsite || undefined,
      license_number: formState.license_number || undefined,
      license_expiry: formState.license_expiry || undefined,
      license_verified: formState.license_verified,
      insurance_expiry: formState.insurance_expiry || undefined,
      insurance_provider: formState.insurance_provider || undefined,
      w9_on_file: formState.w9_on_file,
      prequalified: formState.prequalified,
      rating: formState.rating === "none" ? undefined : Number(formState.rating),
      default_payment_terms: formState.default_payment_terms || undefined,
      internal_notes: formState.internal_notes || undefined,
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

  const setBooleanField = (key: string, value: boolean) => {
    setFormState((prev) => ({ ...prev, [key]: value }))
  }

  const setAddressField = (key: string, value: string) => {
    setFormState((prev) => ({ ...prev, address: { ...prev.address, [key]: value } }))
  }

  return (
    <form className="flex h-full flex-col" onSubmit={handleSubmit}>
      <div className="flex-1 space-y-5 overflow-y-auto pr-1">
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
            <SelectTrigger className="w-full">
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
            <SelectTrigger className="w-full">
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
          <Label>License expiry</Label>
          <Input type="date" value={formState.license_expiry} onChange={(e) => setField("license_expiry", e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>Insurance provider</Label>
          <Input value={formState.insurance_provider} onChange={(e) => setField("insurance_provider", e.target.value)} placeholder="Carrier name" />
        </div>
        <div className="space-y-2">
          <Label>Performance rating</Label>
          <Select value={formState.rating} onValueChange={(value) => setField("rating", value)}>
            <SelectTrigger>
              <SelectValue placeholder="Select rating" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No rating</SelectItem>
              <SelectItem value="1">1</SelectItem>
              <SelectItem value="2">2</SelectItem>
              <SelectItem value="3">3</SelectItem>
              <SelectItem value="4">4</SelectItem>
              <SelectItem value="5">5</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Default payment terms</Label>
          <Input
            value={formState.default_payment_terms}
            onChange={(e) => setField("default_payment_terms", e.target.value)}
            placeholder="Net 30, 2/10 Net 30..."
          />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Switch checked={formState.license_verified} onCheckedChange={(checked) => setBooleanField("license_verified", checked)} />
          <div>
            <div className="text-sm font-medium">License verified</div>
            <div className="text-xs text-muted-foreground">Track verification status</div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Switch checked={formState.w9_on_file} onCheckedChange={(checked) => setBooleanField("w9_on_file", checked)} />
          <div>
            <div className="text-sm font-medium">W-9 on file</div>
            <div className="text-xs text-muted-foreground">Tax document status</div>
          </div>
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <Switch checked={formState.prequalified} onCheckedChange={(checked) => setBooleanField("prequalified", checked)} />
          <div>
            <div className="text-sm font-medium">Prequalified</div>
            <div className="text-xs text-muted-foreground">Approved to bid/work</div>
          </div>
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
        <Label>Internal notes</Label>
        <Textarea
          value={formState.internal_notes}
          onChange={(e) => setField("internal_notes", e.target.value)}
          placeholder="Performance notes, preferred contacts, safety incidents, pricing notes..."
        />
      </div>

        <div className="space-y-2">
          <Label>Notes</Label>
          <Textarea value={formState.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="Insurance carrier, crew size, specialties..." />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : company ? "Update company" : "Create company"}
        </Button>
      </div>
    </form>
  )
}
