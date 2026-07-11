"use client"

import { useActionState, useState } from "react"
import { useRouter } from "next/navigation"

import { provisionPlatformOrgAction } from "@/app/(app)/platform/actions"
import { AlertCircle, CheckCircle, ChevronDown, Copy, ExternalLink, Plus, Trash2, UserPlus } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import type { ProductTier } from "@/lib/product-tier"

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

export function ProvisionOrgSheet({ plans, action = provisionPlatformOrgAction }: ProvisionOrgSheetProps) {
  void plans
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [state, formAction, pending] = useActionState(action, initialState)
  const [orgName, setOrgName] = useState("")
  const [slug, setSlug] = useState("")
  const [billingModel, setBillingModel] = useState<"subscription" | "license">("subscription")
  const [productTier, setProductTier] = useState<ProductTier>("residential")
  const [priceOpen, setPriceOpen] = useState(false)
  const [collectionMethod, setCollectionMethod] = useState<"checkout" | "invoice">("checkout")
  const [sendInvites, setSendInvites] = useState(false)
  const [seedSampleProject, setSeedSampleProject] = useState(true)
  const [teamMembers, setTeamMembers] = useState<TeamMemberDraft[]>([])

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
            <SheetDescription>Create workspace access first. Add billing only when the deal is already closed.</SheetDescription>
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
                    <h3 className="text-sm font-medium">Access</h3>
                    <p className="mt-1 text-sm text-muted-foreground">This creates the customer workspace before billing starts.</p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-3">
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
                      <Label htmlFor="platform-product-tier">Product posture</Label>
                      <select
                        id="platform-product-tier"
                        name="productTier"
                        value={productTier}
                        onChange={(event) => {
                          const value = event.target.value
                          if (value === "residential" || value === "commercial" || value === "production") {
                            setProductTier(value)
                          }
                        }}
                        className={selectClassName}
                      >
                        <option value="residential">Arc</option>
                        <option value="commercial">Arc Commercial</option>
                        <option value="production">Arc Production</option>
                      </select>
                    </div>
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="platform-trial-days">Trial days</Label>
                      <Input id="platform-trial-days" name="trialDays" type="number" min="1" max="60" defaultValue="30" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 border bg-muted/20 px-4 py-3">
                    <div className="grid gap-1.5">
                      <Label htmlFor="platform-seed-sample-project" className="text-sm font-medium">
                        Seed sample project
                      </Label>
                      <p className="text-sm text-muted-foreground">Adds a Naples remodel sample so the workspace is useful on first login.</p>
                    </div>
                    <Switch
                      id="platform-seed-sample-project"
                      checked={seedSampleProject}
                      onCheckedChange={setSeedSampleProject}
                    />
                    <input type="hidden" name="seedSampleProject" value={seedSampleProject ? "true" : "false"} />
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
                        Leave this off to prepare the org before the client gets access.
                      </p>
                    </div>
                    <input type="hidden" name="sendInvites" value={sendInvites ? "true" : "false"} />
                  </div>
                </section>

                <section className="flex flex-col gap-4">
                  <div>
                    <h3 className="text-sm font-medium">Organization</h3>
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

                {billingModel === "subscription" && (
                  <section className="flex flex-col gap-4">
                    <Collapsible open={priceOpen} onOpenChange={setPriceOpen} className="border bg-muted/20">
                      <CollapsibleTrigger asChild>
                        <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left">
                          <span>
                            <span className="block text-sm font-medium">Set price now</span>
                            <span className="block text-sm text-muted-foreground">Use only when the deal is already closed.</span>
                          </span>
                          <ChevronDown className={`size-4 transition-transform ${priceOpen ? "rotate-180" : ""}`} />
                        </button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="border-t px-4 py-4">
                        <div className="grid gap-4 md:grid-cols-2">
                          <div className="flex flex-col gap-2">
                            <Label htmlFor="platform-amount-dollars">Amount</Label>
                            <Input id="platform-amount-dollars" name="amountDollars" type="number" min="1" step="1" placeholder="2500" />
                          </div>
                          <div className="flex flex-col gap-2">
                            <Label htmlFor="platform-interval">Interval</Label>
                            <select id="platform-interval" name="interval" defaultValue="month" className={selectClassName}>
                              <option value="month">Monthly</option>
                              <option value="year">Annual</option>
                            </select>
                          </div>
                          <div className="flex flex-col gap-2 md:col-span-2">
                            <Label htmlFor="platform-collection-method">Payment method</Label>
                            <select
                              id="platform-collection-method"
                              name="collectionMethod"
                              value={collectionMethod}
                              onChange={(event) => setCollectionMethod(event.target.value as "checkout" | "invoice")}
                              className={selectClassName}
                            >
                              <option value="checkout">Card - send checkout link</option>
                              <option value="invoice">ACH invoice - Stripe emails it</option>
                            </select>
                          </div>
                          {collectionMethod === "invoice" && (
                            <div className="flex flex-col gap-2">
                              <Label htmlFor="platform-net-days">Net days</Label>
                              <Input id="platform-net-days" name="netDays" type="number" min="1" max="90" defaultValue="30" />
                            </div>
                          )}
                        </div>
                      </CollapsibleContent>
                    </Collapsible>
                  </section>
                )}

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
              <Button type="submit" disabled={pending}>
                {pending ? "Creating..." : "Create Client"}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  )
}
