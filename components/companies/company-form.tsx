"use client"

import { useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronsUpDown, Loader2, PlusCircle } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
import {
  createCompanyAction,
  createQboVendorForCompanyAction,
  getCompanyQboVendorContextAction,
  linkCompanyQboVendorAction,
  updateCompanyAction,
} from "@/app/(app)/companies/actions"
import { useToast } from "@/hooks/use-toast"

import { unwrapAction } from "@/lib/action-result"

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
  const [isAccountingPending, startAccountingTransition] = useTransition()
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
    prequalified: company?.prequalified ?? false,
    rating: company?.rating ? String(company.rating) : "none",
    default_payment_terms: company?.default_payment_terms ?? "",
    internal_notes: company?.internal_notes ?? "",
    notes: company?.notes ?? "",
    qbo_vendor_id: company?.qbo_vendor_id ?? "",
    qbo_vendor_name: company?.qbo_vendor_name ?? "",
    qbo_vendor_synced_at: company?.qbo_vendor_synced_at ?? "",
    qbo_vendor_sync_status: company?.qbo_vendor_sync_status ?? "",
    tax_id_last4: company?.tax_id_last4 ?? "",
    tax_entity_type: company?.tax_entity_type ?? "none",
    is_1099_eligible: company?.is_1099_eligible ?? false,
    address: {
      street1: company?.address?.street1 ?? "",
      street2: company?.address?.street2 ?? "",
      city: company?.address?.city ?? "",
      state: company?.address?.state ?? "",
      postal_code: company?.address?.postal_code ?? "",
    },
  })
  const [accountingEnabled, setAccountingEnabled] = useState(false)
  const [qboVendors, setQboVendors] = useState<Array<{ id: string; name: string }>>([])
  const [qboVendorOpen, setQboVendorOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    getCompanyQboVendorContextAction()
      .then((context) => {
        if (cancelled) return
        setAccountingEnabled(Boolean(context.enabled))
        setQboVendors(context.vendors ?? [])
      })
      .catch(() => {
        if (!cancelled) setAccountingEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
      prequalified: formState.prequalified,
      rating: formState.rating === "none" ? undefined : Number(formState.rating),
      default_payment_terms: formState.default_payment_terms || undefined,
      internal_notes: formState.internal_notes || undefined,
      notes: formState.notes || undefined,
      qbo_vendor_id: formState.qbo_vendor_id || undefined,
      qbo_vendor_name: formState.qbo_vendor_name || undefined,
      qbo_vendor_synced_at: formState.qbo_vendor_id
        ? formState.qbo_vendor_synced_at || company?.qbo_vendor_synced_at || new Date().toISOString()
        : undefined,
      qbo_vendor_sync_status: formState.qbo_vendor_id
        ? (formState.qbo_vendor_sync_status as "linked" | "created" | "needs_review" | "error") || "linked"
        : undefined,
      tax_id_last4: formState.tax_id_last4 || undefined,
      tax_entity_type: formState.tax_entity_type === "none" ? undefined : formState.tax_entity_type,
      is_1099_eligible: formState.is_1099_eligible,
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
          unwrapAction(await updateCompanyAction(company.id, payload))
        } else {
          unwrapAction(await createCompanyAction(payload))
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

  const setQboVendor = (vendorId: string) => {
    const vendor = qboVendors.find((option) => option.id === vendorId)
    setFormState((prev) => ({
      ...prev,
      qbo_vendor_id: vendorId,
      qbo_vendor_name: vendor?.name ?? prev.qbo_vendor_name,
      qbo_vendor_sync_status: "linked",
      qbo_vendor_synced_at: new Date().toISOString(),
    }))
    if (!company || !vendor) return
    startAccountingTransition(async () => {
      try {
        unwrapAction(await linkCompanyQboVendorAction(company.id, vendor))
        setQboVendorOpen(false)
        router.refresh()
        toast({ title: "QuickBooks vendor linked" })
      } catch (error) {
        toast({ title: "Unable to link QuickBooks vendor", description: (error as Error).message })
      }
    })
  }

  const createQboVendor = () => {
    if (!company) return
    startAccountingTransition(async () => {
      try {
        const updated = unwrapAction(await createQboVendorForCompanyAction(company.id))
        setFormState((prev) => ({
          ...prev,
          qbo_vendor_id: updated.qbo_vendor_id ?? "",
          qbo_vendor_name: updated.qbo_vendor_name ?? "",
          qbo_vendor_synced_at: updated.qbo_vendor_synced_at ?? "",
          qbo_vendor_sync_status: updated.qbo_vendor_sync_status ?? "created",
        }))
        setQboVendors((prev) => {
          if (!updated.qbo_vendor_id || prev.some((vendor) => vendor.id === updated.qbo_vendor_id)) return prev
          return [...prev, { id: updated.qbo_vendor_id, name: updated.qbo_vendor_name ?? updated.name }]
            .sort((a, b) => a.name.localeCompare(b.name))
        })
        router.refresh()
        setQboVendorOpen(false)
        toast({ title: "QuickBooks vendor created" })
      } catch (error) {
        toast({ title: "Unable to create QuickBooks vendor", description: (error as Error).message })
      }
    })
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
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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

      {accountingEnabled ? (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">QuickBooks vendor</div>
              <div className="text-xs text-muted-foreground">
                Link this Arc company to the vendor record used for bills and payments.
              </div>
            </div>
            {formState.qbo_vendor_id ? (
              <div className="shrink-0 rounded-md border bg-background px-2 py-1 text-[11px] font-medium text-muted-foreground">
                Linked
              </div>
            ) : null}
          </div>
          <div className="space-y-2">
            <Popover open={qboVendorOpen} onOpenChange={setQboVendorOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={qboVendorOpen}
                  disabled={isAccountingPending}
                  className="h-10 w-full justify-between px-3 text-left"
                >
                  <span className={cn("truncate", !formState.qbo_vendor_name && "text-muted-foreground")}>
                    {formState.qbo_vendor_name || (company ? "Link or create QuickBooks vendor" : "Link existing QuickBooks vendor")}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command>
                  <CommandInput placeholder="Search QuickBooks vendors..." />
                  <CommandList className="max-h-72 overflow-y-auto">
                    {company ? (
                      <CommandGroup>
                        <CommandItem
                          value={`create ${formState.name}`}
                          disabled={!formState.name.trim() || isAccountingPending}
                          onSelect={createQboVendor}
                          className="m-1 border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 data-[selected=true]:bg-primary/10"
                        >
                          {isAccountingPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <PlusCircle className="size-4 text-primary" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              Create "{formState.name.trim() || "this vendor"}" in QuickBooks
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              Uses this Arc vendor name and profile details
                            </span>
                          </span>
                        </CommandItem>
                      </CommandGroup>
                    ) : null}
                    <CommandEmpty>No QuickBooks vendors found.</CommandEmpty>
                    <CommandGroup heading="Existing QuickBooks vendors">
                      {qboVendors.map((vendor) => {
                        const selected = vendor.id === formState.qbo_vendor_id
                        return (
                          <CommandItem key={vendor.id} value={vendor.name} onSelect={() => setQboVendor(vendor.id)}>
                            <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
                            <span className="truncate">{vendor.name}</span>
                          </CommandItem>
                        )
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {isAccountingPending ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Updating QuickBooks vendor link...
              </p>
            ) : null}
          </div>
          {formState.qbo_vendor_name ? (
            <p className="text-xs text-muted-foreground">Current link: {formState.qbo_vendor_name}</p>
          ) : company ? (
            <p className="text-xs text-muted-foreground">No QuickBooks vendor linked yet.</p>
          ) : (
            <p className="text-xs text-muted-foreground">Create the company first to create a new QuickBooks vendor from this record.</p>
          )}
        </div>
      ) : null}

      <div className="space-y-3 border p-4">
        <div>
          <div className="text-sm font-medium">Vendor tax profile</div>
          <div className="text-xs text-muted-foreground">Store only the TIN last four; the full number remains in the audited W-9 file.</div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label>Entity type</Label>
            <Select value={formState.tax_entity_type} onValueChange={(value) => setField("tax_entity_type", value)}>
              <SelectTrigger><SelectValue placeholder="Select entity type" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not set</SelectItem>
                <SelectItem value="individual">Individual</SelectItem>
                <SelectItem value="sole_prop">Sole proprietor</SelectItem>
                <SelectItem value="partnership">Partnership</SelectItem>
                <SelectItem value="llc">LLC</SelectItem>
                <SelectItem value="c_corp">C corporation</SelectItem>
                <SelectItem value="s_corp">S corporation</SelectItem>
                <SelectItem value="exempt">Exempt</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tax-id-last4">TIN last four</Label>
            <Input id="tax-id-last4" inputMode="numeric" maxLength={4} pattern="[0-9]{4}" value={formState.tax_id_last4} onChange={(event) => setField("tax_id_last4", event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="1234" />
          </div>
          <div className="flex items-center gap-3 border p-3">
            <Switch checked={formState.is_1099_eligible} onCheckedChange={(checked) => setBooleanField("is_1099_eligible", checked)} />
            <div>
              <div className="text-sm font-medium">1099 eligible</div>
              <div className="text-xs text-muted-foreground">Bookkeeper-confirmed reporting status</div>
            </div>
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
