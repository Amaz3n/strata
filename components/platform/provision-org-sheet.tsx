"use client"

import { useActionState, useMemo, useState } from "react"
import { useRouter } from "next/navigation"

import { provisionPlatformOrgAction } from "@/app/(app)/platform/actions"
import { AlertCircle, CheckCircle, Copy, ExternalLink, Plus, Trash2, UserPlus } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

interface PlanOption {
  code: string
  name: string
  publicName?: string | null
  packageType?: string | null
  featureKeys?: string[]
  pricingModel: string
  amountCents?: number | null
  interval?: string | null
  stripePriceId?: string | null
  isActive: boolean
}

type OnboardingState = {
  error?: string
  message?: string
  checkoutUrl?: string
  orgId?: string
  orgName?: string
  invitedCount?: number
}

interface ProvisionOrgSheetProps {
  plans: PlanOption[]
  action?: (prevState: OnboardingState, formData: FormData) => Promise<OnboardingState>
}

type TeamMemberDraft = {
  id: number
  fullName: string
  email: string
  role: "org_admin" | "org_user"
}

const initialState: OnboardingState = {}
const selectClassName =
  "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function formatPlanPrice(plan: PlanOption) {
  if (plan.amountCents == null) return "custom"
  const amount = `$${(plan.amountCents / 100).toFixed(0)}`
  if (!plan.interval) return amount
  return `${amount}/${plan.interval === "monthly" ? "mo" : plan.interval === "yearly" ? "yr" : plan.interval}`
}

export function ProvisionOrgSheet({ plans, action = provisionPlatformOrgAction }: ProvisionOrgSheetProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(action, initialState)
  const [orgName, setOrgName] = useState("")
  const [slug, setSlug] = useState("")
  const [billingModel, setBillingModel] = useState<"subscription" | "license">("subscription")
  const [createCheckout, setCreateCheckout] = useState(true)
  const [sendInvites, setSendInvites] = useState(false)
  const [teamMembers, setTeamMembers] = useState<TeamMemberDraft[]>([])

  const subscriptionPlans = useMemo(
    () => plans.filter((plan) => plan.isActive && plan.pricingModel === "subscription"),
    [plans],
  )
  const checkoutReadyPlans = subscriptionPlans.filter((plan) => Boolean(plan.stripePriceId))
  const defaultPlanCode = checkoutReadyPlans[0]?.code ?? subscriptionPlans[0]?.code ?? ""

  const addTeamMember = () => {
    setTeamMembers((current) => [
      ...current,
      { id: Date.now(), fullName: "", email: "", role: "org_user" },
    ])
  }

  const updateTeamMember = (id: number, patch: Partial<TeamMemberDraft>) => {
    setTeamMembers((current) => current.map((member) => (member.id === id ? { ...member, ...patch } : member)))
  }

  const removeTeamMember = (id: number) => {
    setTeamMembers((current) => current.filter((member) => member.id !== id))
  }

  const copyCheckoutLink = async () => {
    if (!state.checkoutUrl) return
    await navigator.clipboard.writeText(state.checkoutUrl)
  }

  return (
    <>
      <Button size="sm" className="h-8 rounded-none" onClick={() => setOpen(true)}>
        <UserPlus data-icon="inline-start" />
        New Client
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col rounded-none p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-2xl sm:rounded-none fast-sheet-animation"
          style={
            {
              animationDuration: "150ms",
              transitionDuration: "150ms",
            } as React.CSSProperties
          }
        >
          <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
            <SheetTitle>New Client Onboarding</SheetTitle>
            <SheetDescription>Create the org, invite initial people, and generate the first subscription checkout link.</SheetDescription>
          </SheetHeader>

          <form
            action={async (formData) => {
              await formAction(formData)
              router.refresh()
            }}
            className="flex flex-1 flex-col overflow-hidden"
          >
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className="flex flex-col gap-7">
                <section className="flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-medium">Organization</h3>
                    <p className="mt-1 text-sm text-muted-foreground">This creates the customer workspace before billing starts.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-org-name">Organization name</Label>
                      <Input
                        id="platform-org-name"
                        name="orgName"
                        value={orgName}
                        onChange={(event) => {
                          const nextName = event.target.value
                          setOrgName(nextName)
                          if (!slug) setSlug(slugify(nextName))
                        }}
                        onBlur={() => {
                          if (!slug && orgName) setSlug(slugify(orgName))
                        }}
                        placeholder="Acme Builders"
                        required
                      />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-org-slug">Organization slug</Label>
                      <Input
                        id="platform-org-slug"
                        name="slug"
                        value={slug}
                        onChange={(event) => setSlug(slugify(event.target.value))}
                        placeholder="acme-builders"
                        required
                      />
                    </div>
                  </div>
                </section>

                <section className="flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-medium">Primary Owner</h3>
                    <p className="mt-1 text-sm text-muted-foreground">This person is added as the organization owner. You can send the workspace invite now or defer it.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-full-name">Full name</Label>
                      <Input id="platform-full-name" name="fullName" placeholder="Jordan Lee" required />
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-primary-email">Email</Label>
                      <Input id="platform-primary-email" name="primaryEmail" type="email" placeholder="owner@acme.com" required />
                    </div>
                  </div>
                  <div className="flex items-start gap-3 border bg-muted/20 px-4 py-3">
                    <Checkbox
                      id="platform-send-invites"
                      checked={sendInvites}
                      onCheckedChange={(checked) => setSendInvites(checked === true)}
                    />
                    <div className="grid gap-1.5 leading-none">
                      <Label htmlFor="platform-send-invites" className="text-sm font-medium">
                        Send workspace invites now
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        Leave this off to collect payment first and manually prepare the org before the client gets access.
                      </p>
                    </div>
                    <input type="hidden" name="sendInvites" value={sendInvites ? "true" : "false"} />
                  </div>
                </section>

                <section className="flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium">Initial Team</h3>
                      <p className="mt-1 text-sm text-muted-foreground">Optional admins or users to add during setup.</p>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addTeamMember}>
                      <Plus data-icon="inline-start" />
                      Add Person
                    </Button>
                  </div>

                  {teamMembers.length === 0 ? (
                    <div className="border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">No extra people yet.</div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {teamMembers.map((member, index) => (
                        <div key={member.id} className="grid gap-3 border bg-background p-3 md:grid-cols-[1fr_1fr_140px_auto]">
                          <div className="flex flex-col gap-2">
                            <Label htmlFor={`team-name-${member.id}`}>Name</Label>
                            <Input
                              id={`team-name-${member.id}`}
                              name="teamMemberName"
                              value={member.fullName}
                              onChange={(event) => updateTeamMember(member.id, { fullName: event.target.value })}
                              placeholder={`Team member ${index + 1}`}
                            />
                          </div>
                          <div className="flex flex-col gap-2">
                            <Label htmlFor={`team-email-${member.id}`}>Email</Label>
                            <Input
                              id={`team-email-${member.id}`}
                              name="teamMemberEmail"
                              type="email"
                              value={member.email}
                              onChange={(event) => updateTeamMember(member.id, { email: event.target.value })}
                              placeholder="person@acme.com"
                            />
                          </div>
                          <div className="flex flex-col gap-2">
                            <Label htmlFor={`team-role-${member.id}`}>Role</Label>
                            <select
                              id={`team-role-${member.id}`}
                              name="teamMemberRole"
                              value={member.role}
                              onChange={(event) => updateTeamMember(member.id, { role: event.target.value as TeamMemberDraft["role"] })}
                              className={selectClassName}
                            >
                              <option value="org_user">User</option>
                              <option value="org_admin">Admin</option>
                            </select>
                          </div>
                          <div className="flex items-end">
                            <Button type="button" variant="ghost" size="icon" onClick={() => removeTeamMember(member.id)} aria-label="Remove person">
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-medium">Billing</h3>
                    <p className="mt-1 text-sm text-muted-foreground">For subscriptions, generate the Stripe Checkout link you will send to the client.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-billing-model">Billing model</Label>
                      <select
                        id="platform-billing-model"
                        name="billingModel"
                        value={billingModel}
                        onChange={(event) => setBillingModel(event.target.value as "subscription" | "license")}
                        className={selectClassName}
                      >
                        <option value="subscription">Subscription</option>
                        <option value="license">License</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-trial-days">Trial days</Label>
                      <Input id="platform-trial-days" name="trialDays" type="number" min="1" max="30" defaultValue="7" />
                    </div>
                  </div>

                  {billingModel === "subscription" && (
                    <div className="flex flex-col gap-4 border bg-muted/20 p-4">
                      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
                        <div className="flex flex-col gap-2">
                          <Label htmlFor="platform-plan-code">Plan</Label>
                          <select id="platform-plan-code" name="planCode" defaultValue={defaultPlanCode} className={selectClassName}>
                            {subscriptionPlans.length === 0 ? (
                              <option value="">No active subscription plans</option>
                            ) : (
                              subscriptionPlans.map((plan) => (
                                <option key={plan.code} value={plan.code} disabled={!plan.stripePriceId}>
                                  {plan.name} ({formatPlanPrice(plan)})
                                  {plan.packageType === "custom" ? ` - custom package, ${plan.featureKeys?.length ?? 0} features` : " - full access"}
                                  {!plan.stripePriceId ? " - missing Stripe price" : ""}
                                </option>
                              ))
                            )}
                          </select>
                        </div>
                        <div className="flex items-end gap-2 pb-2">
                          <Checkbox
                            id="platform-create-checkout"
                            checked={createCheckout}
                            onCheckedChange={(checked) => setCreateCheckout(checked === true)}
                          />
                          <Label htmlFor="platform-create-checkout" className="text-sm font-normal">
                            Create Checkout link
                          </Label>
                          <input type="hidden" name="createCheckout" value={createCheckout ? "true" : "false"} />
                        </div>
                      </div>
                      {checkoutReadyPlans.length === 0 && (
                        <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                          <AlertCircle className="mt-0.5 size-4" />
                          <span>Add a Stripe Price ID to an active plan before creating subscription checkout links.</span>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                {state.error && (
                  <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 size-4" />
                    <span>{state.error}</span>
                  </div>
                )}

                {state.message && !state.error && (
                  <div className="flex flex-col gap-3 border bg-muted/20 px-4 py-3 text-sm">
                    <div className="flex items-start gap-2">
                      <CheckCircle className="mt-0.5 size-4 text-primary" />
                      <div>
                        <p className="font-medium">{state.message}</p>
                        {state.orgName && (
                          <p className="text-muted-foreground">
                            {state.orgName} is ready with {state.invitedCount ?? 1} initial person{state.invitedCount === 1 ? "" : "s"}.
                          </p>
                        )}
                      </div>
                    </div>
                    {state.checkoutUrl && (
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="platform-checkout-url">Checkout link</Label>
                        <div className="flex gap-2">
                          <Input id="platform-checkout-url" value={state.checkoutUrl} readOnly />
                          <Button type="button" variant="outline" size="icon" onClick={copyCheckoutLink} aria-label="Copy checkout link">
                            <Copy />
                          </Button>
                          <Button type="button" variant="outline" size="icon" asChild aria-label="Open checkout link">
                            <a href={state.checkoutUrl} target="_blank" rel="noreferrer">
                              <ExternalLink />
                            </a>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t bg-background px-6 py-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button type="submit" disabled={pending || (billingModel === "subscription" && createCheckout && checkoutReadyPlans.length === 0)}>
                {pending ? "Creating..." : "Create Client"}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}
