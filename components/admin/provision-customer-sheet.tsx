"use client"

import { useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { UserPlus, Building2 } from "@/components/icons"

interface ProvisionCustomerSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onProvision: (formData: FormData) => Promise<void> | void
  loading?: boolean
}

export function ProvisionCustomerSheet({
  open,
  onOpenChange,
  onProvision,
  loading,
}: ProvisionCustomerSheetProps) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [billingModel, setBillingModel] = useState("subscription")
  const [primaryName, setPrimaryName] = useState("")
  const [primaryEmail, setPrimaryEmail] = useState("")
  const [planCode, setPlanCode] = useState("local-pro")
  const [trialDays, setTrialDays] = useState("7")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const formData = new FormData()
    formData.append("name", name)
    formData.append("slug", slug)
    formData.append("billingModel", billingModel)
    formData.append("primaryName", primaryName)
    formData.append("primaryEmail", primaryEmail)
    formData.append("planCode", planCode)
    formData.append("trialDays", trialDays)

    try {
      await onProvision(formData)

      // Reset form on success
      setName("")
      setSlug("")
      setBillingModel("subscription")
      setPrimaryName("")
      setPrimaryEmail("")
      setPlanCode("local-pro")
      setTrialDays("7")

      onOpenChange(false)
    } catch (error: any) {
      console.error(error)
      toast.error("Failed to provision customer", { description: error?.message ?? "Please try again." })
    }
  }

  const resetForm = () => {
    setName("")
    setSlug("")
    setBillingModel("subscription")
    setPrimaryName("")
    setPrimaryEmail("")
    setPlanCode("local-pro")
    setTrialDays("7")
  }

  return (
    <Sheet open={open} onOpenChange={(val) => { if (!val) resetForm(); onOpenChange(val) }}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Provision New Customer
          </SheetTitle>
          <SheetDescription>
            Create a new customer organization and set up their account.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Organization Name *</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Corporation"
                required
              />
              <p className="text-xs text-muted-foreground">
                The display name for this organization
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="primaryName">Primary Contact Name *</Label>
                <Input
                  id="primaryName"
                  value={primaryName}
                  onChange={(e) => setPrimaryName(e.target.value)}
                  placeholder="Jordan Lee"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="primaryEmail">Primary Contact Email *</Label>
                <Input
                  id="primaryEmail"
                  type="email"
                  value={primaryEmail}
                  onChange={(e) => setPrimaryEmail(e.target.value)}
                  placeholder="owner@acme.com"
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="slug">Slug *</Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="acme-corp"
                required
              />
              <p className="text-xs text-muted-foreground">
                Unique identifier (lowercase, numbers, hyphens only)
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="planCode">Plan Code</Label>
                <Input
                  id="planCode"
                  value={planCode}
                  onChange={(e) => setPlanCode(e.target.value)}
                  placeholder="local-pro"
                />
                <p className="text-xs text-muted-foreground">Defaults to your standard plan code.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="trialDays">Trial Days</Label>
                <Input
                  id="trialDays"
                  type="number"
                  min="1"
                  max="30"
                  value={trialDays}
                  onChange={(e) => setTrialDays(e.target.value)}
                  placeholder="7"
                />
                <p className="text-xs text-muted-foreground">Set trial length (1–30 days).</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="billingModel">Billing Model *</Label>
              <Select value={billingModel} onValueChange={setBillingModel}>
                <SelectTrigger>
                  <SelectValue placeholder="Select billing model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="subscription">Subscription</SelectItem>
                  <SelectItem value="license">License</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Subscription: recurring billing, License: one-time purchase
              </p>
            </div>

            <Separator />

            <div className="bg-muted/30 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <Building2 className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">What happens next?</h4>
                  <ul className="text-xs text-muted-foreground space-y-1">
                    <li>• Organization account will be created</li>
                    <li>• Default admin user will be provisioned</li>
                    <li>• Welcome email will be sent</li>
                    <li>• Billing will be set up based on selected model</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1"
                disabled={loading}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={loading}
                className="flex-1"
              >
                {loading ? "Provisioning..." : "Provision Customer"}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}