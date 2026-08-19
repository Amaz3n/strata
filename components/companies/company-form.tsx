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
  createAccountingVendorForCompanyAction,
  getCompanyAccountingVendorContextAction,
  linkCompanyAccountingVendorAction,
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
  initialName?: string
  onSubmitted?: (company: Company) => void
  onCancel?: () => void
  /** Payables uses a concise, sectioned vendor profile instead of directory-only notes and ratings. */
  payablesMode?: boolean
}

const PAYMENT_TERMS = ["Due on receipt", "Net 7", "Net 15", "Net 30", "Net 45", "Net 60", "Net 90"] as const

export function CompanyForm({ company, initialName, onSubmitted, onCancel, payablesMode = false }: CompanyFormProps) {
  const [isPending, startTransition] = useTransition()
  const [isAccountingPending, startAccountingTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const allowedTypes = new Set(COMPANY_TYPES.map((type) => type.value))
  const fallbackTrade = company?.trade ?? (company && !allowedTypes.has(company.company_type) ? company.company_type : undefined)

  const [formState, setFormState] = useState({
    name: company?.name ?? initialName ?? "",
    company_type: (company?.company_type && allowedTypes.has(company.company_type)) ? company.company_type : "subcontractor",
    trade: fallbackTrade ?? "none",
    phone: company?.phone ?? "",
    email: company?.email ?? "",
    website: company?.website ?? "",
    license_number: company?.license_number ?? "",
    rating: company?.rating ? String(company.rating) : "none",
    default_payment_terms: company?.default_payment_terms ?? "",
    default_payment_method: company?.default_payment_method ?? "arc_pay",
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
  const [accountingVendors, setAccountingVendors] = useState<Array<{ id: string; name: string }>>([])
  const [accountingVendorOpen, setAccountingVendorOpen] = useState(false)
  /** Falls back to a neutral noun until the connected provider names itself. */
  const [providerName, setProviderName] = useState("Accounting")
  const [canCreateAccountingVendor, setCanCreateAccountingVendor] = useState(false)

  useEffect(() => {
    let cancelled = false
    getCompanyAccountingVendorContextAction()
      .then((context) => {
        if (cancelled) return
        setAccountingEnabled(Boolean(context.enabled))
        setAccountingVendors(context.vendors ?? [])
        if (context.providerName) setProviderName(context.providerName)
        setCanCreateAccountingVendor(Boolean(context.canCreate))
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
      rating: formState.rating === "none" ? undefined : Number(formState.rating),
      default_payment_terms: formState.default_payment_terms || undefined,
      default_payment_method: formState.default_payment_method,
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
        const saved = company
          ? unwrapAction(await updateCompanyAction(company.id, payload))
          : unwrapAction(await createCompanyAction(payload))
        router.refresh()
        toast({ title: company ? "Company updated" : "Company created" })
        onSubmitted?.(saved)
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

  const setAccountingVendor = (vendorId: string) => {
    const vendor = accountingVendors.find((option) => option.id === vendorId)
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
        unwrapAction(await linkCompanyAccountingVendorAction(company.id, vendor))
        setAccountingVendorOpen(false)
        router.refresh()
        toast({ title: `${providerName} vendor linked` })
      } catch (error) {
        toast({ title: `Unable to link the ${providerName} vendor`, description: (error as Error).message })
      }
    })
  }

  const createAccountingVendor = () => {
    if (!company) return
    startAccountingTransition(async () => {
      try {
        const updated = unwrapAction(await createAccountingVendorForCompanyAction(company.id))
        setFormState((prev) => ({
          ...prev,
          qbo_vendor_id: updated.qbo_vendor_id ?? "",
          qbo_vendor_name: updated.qbo_vendor_name ?? "",
          qbo_vendor_synced_at: updated.qbo_vendor_synced_at ?? "",
          qbo_vendor_sync_status: updated.qbo_vendor_sync_status ?? "created",
        }))
        setAccountingVendors((prev) => {
          if (!updated.qbo_vendor_id || prev.some((vendor) => vendor.id === updated.qbo_vendor_id)) return prev
          return [...prev, { id: updated.qbo_vendor_id, name: updated.qbo_vendor_name ?? updated.name }]
            .sort((a, b) => a.name.localeCompare(b.name))
        })
        router.refresh()
        setAccountingVendorOpen(false)
        toast({ title: `${providerName} vendor created` })
      } catch (error) {
        toast({ title: `Unable to create the ${providerName} vendor`, description: (error as Error).message })
      }
    })
  }

  return (
    <form className={cn("flex flex-col", payablesMode ? "h-auto" : "h-full")} onSubmit={handleSubmit}>
      <div className={cn("flex-1 space-y-5 pr-1", !payablesMode && "overflow-y-auto")}>
        {payablesMode ? (
          <div className="border-b pb-3">
            <h3 className="text-sm font-semibold">Profile</h3>
            <p className="mt-1 text-xs text-muted-foreground">Identity, contact information, and the defaults used on new payables.</p>
          </div>
        ) : null}
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

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {!payablesMode ? (
          <div className="space-y-2">
            <Label>Performance rating</Label>
            <Select value={formState.rating} onValueChange={(value) => setField("rating", value)}>
              <SelectTrigger><SelectValue placeholder="Select rating" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No rating</SelectItem>
                <SelectItem value="1">1</SelectItem><SelectItem value="2">2</SelectItem>
                <SelectItem value="3">3</SelectItem><SelectItem value="4">4</SelectItem><SelectItem value="5">5</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Default payment method</Label>
            <Select value={formState.default_payment_method} onValueChange={(value) => setField("default_payment_method", value)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="arc_pay">Arc Pay</SelectItem>
                <SelectItem value="check">Check</SelectItem>
                <SelectItem value="wire">Wire</SelectItem>
                <SelectItem value="card">Credit card</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="space-y-2">
          <Label>Default payment terms</Label>
          {payablesMode ? (
            <Select value={formState.default_payment_terms || "none"} onValueChange={(value) => setField("default_payment_terms", value === "none" ? "" : value)}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose payment terms" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No default</SelectItem>
                {PAYMENT_TERMS.map((term) => <SelectItem key={term} value={term}>{term}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : (
            <Input value={formState.default_payment_terms} onChange={(e) => setField("default_payment_terms", e.target.value)} placeholder="Net 30, 2/10 Net 30..." />
          )}
        </div>
      </div>

      {accountingEnabled ? (
        <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium">{providerName} vendor</div>
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
            <Popover open={accountingVendorOpen} onOpenChange={setAccountingVendorOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={accountingVendorOpen}
                  disabled={isAccountingPending}
                  className="h-10 w-full justify-between px-3 text-left"
                >
                  <span className={cn("truncate", !formState.qbo_vendor_name && "text-muted-foreground")}>
                    {formState.qbo_vendor_name ||
                      (company && canCreateAccountingVendor
                        ? `Link or create ${providerName} vendor`
                        : `Link existing ${providerName} vendor`)}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                <Command>
                  <CommandInput placeholder={`Search ${providerName} vendors...`} />
                  <CommandList className="max-h-72 overflow-y-auto">
                    {company && canCreateAccountingVendor ? (
                      <CommandGroup>
                        <CommandItem
                          value={`create ${formState.name}`}
                          disabled={!formState.name.trim() || isAccountingPending}
                          onSelect={createAccountingVendor}
                          className="m-1 border border-primary/20 bg-primary/5 text-primary hover:bg-primary/10 data-[selected=true]:bg-primary/10"
                        >
                          {isAccountingPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <PlusCircle className="size-4 text-primary" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              Create &quot;{formState.name.trim() || "this vendor"}&quot; in {providerName}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              Uses this Arc vendor name and profile details
                            </span>
                          </span>
                        </CommandItem>
                      </CommandGroup>
                    ) : null}
                    <CommandEmpty>No {providerName} vendors found.</CommandEmpty>
                    <CommandGroup heading={`Existing ${providerName} vendors`}>
                      {accountingVendors.map((vendor) => {
                        const selected = vendor.id === formState.qbo_vendor_id
                        return (
                          <CommandItem key={vendor.id} value={vendor.name} onSelect={() => setAccountingVendor(vendor.id)}>
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
                Updating {providerName} vendor link...
              </p>
            ) : null}
          </div>
          {formState.qbo_vendor_name ? (
            <p className="text-xs text-muted-foreground">Current link: {formState.qbo_vendor_name}</p>
          ) : company ? (
            <p className="text-xs text-muted-foreground">No {providerName} vendor linked yet.</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Create the company first to create a new {providerName} vendor from this record.
            </p>
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

      {!payablesMode ? <div className="space-y-2">
        <Label>Internal notes</Label>
        <Textarea
          value={formState.internal_notes}
          onChange={(e) => setField("internal_notes", e.target.value)}
          placeholder="Performance notes, preferred contacts, safety incidents, pricing notes..."
        />
      </div> : null}

        {!payablesMode ? <div className="space-y-2">
          <Label>Notes</Label>
          <Textarea value={formState.notes} onChange={(e) => setField("notes", e.target.value)} placeholder="Insurance carrier, crew size, specialties..." />
        </div> : null}
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
