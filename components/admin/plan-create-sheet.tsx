"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DollarSign } from "@/components/icons"

interface PlanCreateSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (formData: FormData) => Promise<void> | void
  loading?: boolean
}

export function PlanCreateSheet({
  open,
  onOpenChange,
  onCreate,
  loading,
}: PlanCreateSheetProps) {
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [pricingModel, setPricingModel] = useState("subscription")
  const [interval, setInterval] = useState("monthly")
  const [amountCents, setAmountCents] = useState("")
  const [currency, setCurrency] = useState("usd")
  const [description, setDescription] = useState("")
  const [isActive, setIsActive] = useState(true)
  const [stripePriceId, setStripePriceId] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    const formData = new FormData()
    formData.append("code", code)
    formData.append("name", name)
    formData.append("pricingModel", pricingModel)
    if (pricingModel === "subscription") {
      formData.append("interval", interval)
    }
    formData.append("amountCents", amountCents)
    formData.append("currency", currency)
    formData.append("stripePriceId", stripePriceId)
    formData.append("description", description)
    formData.append("isActive", isActive.toString())

    await onCreate(formData)
  }

  const resetForm = () => {
    setCode("")
    setName("")
    setPricingModel("subscription")
    setInterval("monthly")
    setAmountCents("")
    setCurrency("usd")
    setStripePriceId("")
    setDescription("")
    setIsActive(true)
  }

  return (
    <Sheet open={open} onOpenChange={(val) => { if (!val) resetForm(); onOpenChange(val) }}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <DollarSign className="h-5 w-5" />
            New Subscription Plan
          </SheetTitle>
          <SheetDescription>
            Create a new pricing plan for your customers.
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex-1 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 min-h-0">
            <div className="px-6 py-4 space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2 min-w-0">
                  <Label htmlFor="code">Plan Code *</Label>
                  <Input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                    placeholder="pro-plan"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Unique identifier (lowercase, numbers, hyphens only)
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Plan Name *</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Professional Plan"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Display name for this plan
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="pricingModel">Pricing Model *</Label>
                <Select value={pricingModel} onValueChange={setPricingModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select pricing model" />
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

              {pricingModel === "subscription" && (
                <div className="space-y-2">
                  <Label htmlFor="interval">Billing Interval *</Label>
                  <Select value={interval} onValueChange={setInterval}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select billing interval" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="yearly">Yearly</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="amountCents">Price (in cents)</Label>
                  <Input
                    id="amountCents"
                    type="number"
                    value={amountCents}
                    onChange={(e) => setAmountCents(e.target.value)}
                    placeholder="9900"
                    min="0"
                  />
                  <p className="text-xs text-muted-foreground">
                    Price in cents (9900 = $99.00). Leave empty for free plans.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="currency">Currency *</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select currency" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="usd">USD</SelectItem>
                      <SelectItem value="eur">EUR</SelectItem>
                      <SelectItem value="gbp">GBP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (Optional)</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Describe what this plan includes..."
                />
                <p className="text-xs text-muted-foreground">
                  Brief description of the plan features and benefits
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="stripePriceId">Stripe Price ID</Label>
                <Input
                  id="stripePriceId"
                  value={stripePriceId}
                  onChange={(e) => setStripePriceId(e.target.value)}
                  placeholder="price_123..."
                />
                <p className="text-xs text-muted-foreground">
                  Optional: link this plan to a Stripe price for subscription checkout.
                </p>
              </div>

              <div className="flex flex-row items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5">
                  <Label htmlFor="isActive" className="text-base font-medium">
                    Active Plan
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Whether this plan is available for new subscriptions
                  </p>
                </div>
                <Switch
                  id="isActive"
                  checked={isActive}
                  onCheckedChange={setIsActive}
                />
              </div>
            </div>
          </ScrollArea>

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
                {loading ? "Creating..." : "Create Plan"}
              </Button>
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}