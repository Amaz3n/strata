"use client"

import { useActionState } from "react"

import { provisionOrgAction } from "@/app/(app)/admin/provision/actions"
import { AlertCircle, CheckCircle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const initialState = {} as { error?: any; message?: any }
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

interface ProvisionOrgFormProps {
  plans?: Array<{
    code: string
    name: string
    pricingModel: string
    isActive: boolean
  }>
  action?: (prevState: { error?: string; message?: string }, formData: FormData) => Promise<{ error?: string; message?: string }>
}

export function ProvisionOrgForm({ action, plans = [] }: ProvisionOrgFormProps) {
  const resolvedAction = action ?? provisionOrgAction
  const [state, formAction, pending] = useActionState(resolvedAction, initialState)
  const subscriptionPlans = plans.filter((plan) => plan.isActive && plan.pricingModel === "subscription")

  return (
    <form action={formAction} className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="orgName">Organization name</Label>
          <Input id="orgName" name="orgName" placeholder="Acme Builders" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="orgSlug">Organization slug</Label>
          <Input id="orgSlug" name="orgSlug" placeholder="acme-builders" required />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="billingModel">Billing model</Label>
          <select id="billingModel" name="billingModel" defaultValue="subscription" className={selectClassName}>
            <option value="subscription">Subscription</option>
            <option value="license">License</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="trialDays">Trial days</Label>
          <Input id="trialDays" name="trialDays" type="number" min="1" max="30" defaultValue="7" />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="fullName">Primary contact name</Label>
          <Input id="fullName" name="fullName" placeholder="Jordan Lee" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="primaryEmail">Primary contact email</Label>
          <Input id="primaryEmail" name="primaryEmail" type="email" placeholder="owner@acme.com" required />
        </div>
      </div>

      <details className="rounded-lg border bg-muted/20 px-4 py-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced billing settings</summary>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="planCode">Plan</Label>
            <select id="planCode" name="planCode" defaultValue={subscriptionPlans[0]?.code ?? ""} className={selectClassName}>
              {subscriptionPlans.length === 0 ? (
                <option value="">No active subscription plans</option>
              ) : (
                subscriptionPlans.map((plan) => (
                  <option key={plan.code} value={plan.code}>
                    {plan.name} ({plan.code})
                  </option>
                ))
              )}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="planCodeHelp">Notes</Label>
            <p id="planCodeHelp" className="rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">
              Plan list is sourced from Manage Plans. If billing model is license, plan is ignored.
            </p>
          </div>
        </div>
      </details>

      {state.error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{state.error}</span>
        </div>
      )}

      {state.message && !state.error && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
          <CheckCircle className="mt-0.5 h-4 w-4" />
          <span>{state.message}</span>
        </div>
      )}

      <Button type="submit" className="w-full md:w-auto" disabled={pending}>
        {pending ? "Provisioning..." : "Provision organization"}
      </Button>
    </form>
  )
}
