"use client"

import { useState, useTransition, type FormEvent } from "react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ChevronDown, Users, Trash2, CreditCard, Copy, ExternalLink } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Link from "next/link"
import { formatDistanceToNow } from "date-fns"
import { CustomerSheet } from "./customer-sheet"
import { CustomerFilters } from "./customer-filters"
import { deleteOrganizationAction } from "@/app/(app)/admin/customers/actions"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { unwrapAction } from "@/lib/action-result"
import { PRODUCT_TIER_LABELS, type ProductTier } from "@/lib/product-tier"

interface CustomerHealth {
  lastActivityAt: string | null
  activeMemberCount: number
  projectCount: number
  eventsLast14d: number
  storageBytes: number
  qboStatus: string | null
  atRisk: boolean
}

interface Customer {
  id: string
  name: string
  slug: string
  status: string
  billingModel: string
  billingEmail: string | null
  productTier: ProductTier
  memberCount: number
  createdAt: string
  health: CustomerHealth
  subscription?: {
    id: string
    planCode: string | null
    status: string
    planName: string | null
    amountCents: number | null
    currency: string | null
    interval: string | null
    currentPeriodEnd: string | null
    trialEndsAt: string | null
    externalCustomerId: string | null
    externalSubscriptionId: string | null
    checkoutUrl: string | null
    collectionMethod: string | null
    netDays: number | null
  } | null
}

interface SubscriptionPlan {
  code: string
  name: string
  amountCents: number | null
  interval: string | null
}

interface CustomersClientProps {
  customers: Customer[]
  totalCount: number
  hasNextPage: boolean
  hasPrevPage: boolean
  search: string
  status: string
  plan: string
  page: number
  subscriptionPlans: SubscriptionPlan[]
  onActivateBilling: (formData: FormData) => Promise<{ success?: boolean; error?: string; checkoutUrl?: string | null; planCode?: string }>
  onExtendTrial: (formData: FormData) => Promise<void>
  onUpdateCustomer: (formData: FormData) => Promise<void>
  onUpdateSubscription: (formData: FormData) => Promise<void>
  onEnterContext: (formData: FormData) => Promise<void>
  onSetStatus: (formData: FormData) => Promise<void>
}

export function CustomersClient({
  customers,
  totalCount,
  hasNextPage,
  hasPrevPage,
  search,
  status,
  plan,
  page,
  subscriptionPlans,
  onActivateBilling,
  onExtendTrial,
  onUpdateCustomer,
  onUpdateSubscription,
  onEnterContext,
  onSetStatus,
}: CustomersClientProps) {
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [billingCustomer, setBillingCustomer] = useState<Customer | null>(null)
  const [billingStatus, setBillingStatus] = useState("active")
  const [savingBilling, startSavingBilling] = useTransition()
  const [activateCustomer, setActivateCustomer] = useState<Customer | null>(null)
  const [activationMethod, setActivationMethod] = useState<"checkout" | "invoice">("checkout")
  const [activationResult, setActivationResult] = useState<{ checkoutUrl?: string | null; message?: string } | null>(null)
  const [activatingBilling, startActivatingBilling] = useTransition()

  const [customerToDelete, setCustomerToDelete] = useState<Customer | null>(null)
  const [deleteConfirmationText, setDeleteConfirmationText] = useState("")
  const [deleting, startDeleting] = useTransition()

  const handleDeleteCustomer = async () => {
    if (!customerToDelete) return

    startDeleting(async () => {
      try {
        const result = unwrapAction(await deleteOrganizationAction(customerToDelete.id))
        if (result.error) {
          toast.error("Failed to delete organization", { description: result.error })
        } else {
          toast.success("Organization deleted", { description: result.message })
          setCustomerToDelete(null)
          setDeleteConfirmationText("")
          window.location.reload()
        }
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to delete organization", { description: error?.message ?? "Please try again." })
      }
    })
  }

  const handleViewCustomer = (customer: Customer) => {
    setSelectedCustomer(customer)
    setSheetOpen(true)
  }

  const openBillingEditor = (customer: Customer) => {
    setBillingCustomer(customer)
    setBillingStatus(customer.subscription?.status ?? "active")
  }

  const openBillingActivation = (customer: Customer) => {
    setActivateCustomer(customer)
    setActivationMethod("checkout")
    setActivationResult(null)
  }

  const handleActivateBillingSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)

    startActivatingBilling(async () => {
      const result = await onActivateBilling(formData)
      if (result.error) {
        toast.error("Failed to activate billing", { description: result.error })
        return
      }

      const message = result.checkoutUrl
        ? "Checkout link created."
        : "Stripe invoice subscription created."
      setActivationResult({ checkoutUrl: result.checkoutUrl, message })
      toast.success("Billing activated", { description: message })
    })
  }

  const copyPaymentLink = async (url?: string | null) => {
    if (!url) return
    await navigator.clipboard.writeText(url)
    toast.success("Payment link copied")
  }

  const handleBillingSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)

    startSavingBilling(async () => {
      try {
        await onUpdateSubscription(formData)
        toast.success("Subscription updated", {
          description: "Local billing state was updated for this organization.",
        })
        setBillingCustomer(null)
        window.location.reload()
      } catch (error: any) {
        console.error(error)
        toast.error("Failed to update subscription", {
          description: error?.message ?? "Please try again.",
        })
      }
    })
  }

  return (
    <div className="space-y-6">
      <CustomerFilters
        search={search}
        status={status}
        plan={plan}
      />

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Organization</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4 text-center">Subscription</TableHead>
              <TableHead className="px-4 py-4 text-center">Posture</TableHead>
              <TableHead className="px-4 py-4 text-center">Onboarding</TableHead>
              <TableHead className="px-4 py-4 text-center">Plan</TableHead>
              <TableHead className="px-4 py-4 text-center">Amount</TableHead>
              <TableHead className="px-4 py-4 text-center">Members</TableHead>
              <TableHead className="px-4 py-4 text-center">Last Active</TableHead>
              <TableHead className="px-4 py-4 text-center">Created</TableHead>
              <TableHead className="px-4 py-4">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.length === 0 ? (
              <TableRow className="divide-x">
                <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Users className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No customers found</p>
                      <p className="text-sm">Try adjusting your search criteria.</p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              customers.map((customer) => {
                const canActivateBilling =
                  customer.billingModel === "subscription" &&
                  customer.subscription?.status !== "active" &&
                  (!customer.subscription?.planCode || customer.subscription.status === "trialing")
                const canCopyPaymentLink =
                  Boolean(customer.subscription?.checkoutUrl) && customer.subscription?.status !== "active"

                return (
                <TableRow key={customer.id} className="divide-x">
                  <TableCell className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <Avatar className="h-8 w-8">
                        <AvatarFallback>
                          {customer.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{customer.name}</span>
                          {customer.health.atRisk && (
                            <Badge variant="destructive" className="rounded-none text-[10px] px-1.5 py-0">
                              At risk
                            </Badge>
                          )}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {customer.slug}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant={getStatusVariant(customer.status)}>
                      {customer.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {customer.subscription ? (
                      <Badge variant={customer.subscription.status === 'active' ? 'default' : 'secondary'}>
                        {customer.subscription.status}
                      </Badge>
                    ) : (
                      <Badge variant="outline">No subscription</Badge>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="outline">
                      {PRODUCT_TIER_LABELS[customer.productTier]}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {customer.productTier === "production" ? (
                      <Button asChild size="sm" variant="ghost"><Link href={`/admin/customers/${customer.id}/onboarding`}>Open</Link></Button>
                    ) : <span className="text-sm text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {customer.subscription ? (
                      <span className="text-sm">{customer.subscription.planName}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    {customer.subscription ? (
                      <div className="text-sm font-medium">
                        {customer.subscription.amountCents
                          ? `$${(customer.subscription.amountCents / 100).toFixed(0)}`
                          : "-"}
                        {customer.subscription.interval ? (
                          <span className="text-muted-foreground">/{customer.subscription.interval}</span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <Users className="h-3 w-3" />
                      <span>{customer.memberCount}</span>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <div className={customer.health.lastActivityAt ? "text-sm" : "text-sm text-muted-foreground"}>
                      {customer.health.lastActivityAt
                        ? formatDistanceToNow(new Date(customer.health.lastActivityAt), { addSuffix: true })
                        : "No activity"}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <div className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(customer.createdAt), { addSuffix: true })}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-4">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" className="gap-1.5">
                          Actions
                          <ChevronDown className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <form action={onEnterContext}>
                          <input type="hidden" name="orgId" value={customer.id} />
                          <input type="hidden" name="reason" value="Platform operator switched org context from customers page." />
                          <DropdownMenuItem asChild>
                            <button type="submit" className="w-full text-left">Enter Context</button>
                          </DropdownMenuItem>
                        </form>
                        <DropdownMenuItem onClick={() => openBillingEditor(customer)}>
                          <CreditCard className="mr-2 h-4 w-4" />
                          Edit Billing
                        </DropdownMenuItem>
                        {canActivateBilling && (
                          <DropdownMenuItem onClick={() => openBillingActivation(customer)}>
                            <CreditCard className="mr-2 h-4 w-4" />
                            Activate Billing
                          </DropdownMenuItem>
                        )}
                        {canCopyPaymentLink && (
                          <DropdownMenuItem onClick={() => copyPaymentLink(customer.subscription?.checkoutUrl)}>
                            <Copy className="mr-2 h-4 w-4" />
                            Copy Payment Link
                          </DropdownMenuItem>
                        )}
                        <form action={onExtendTrial}>
                          <input type="hidden" name="orgId" value={customer.id} />
                          <input type="hidden" name="trialDays" value="7" />
                          <DropdownMenuItem asChild>
                            <button type="submit" className="w-full text-left">Extend Trial +7 Days</button>
                          </DropdownMenuItem>
                        </form>
                        <form action={onExtendTrial}>
                          <input type="hidden" name="orgId" value={customer.id} />
                          <input type="hidden" name="trialDays" value="14" />
                          <DropdownMenuItem asChild>
                            <button type="submit" className="w-full text-left">Extend Trial +14 Days</button>
                          </DropdownMenuItem>
                        </form>
                        <form action={onExtendTrial}>
                          <input type="hidden" name="orgId" value={customer.id} />
                          <input type="hidden" name="trialDays" value="30" />
                          <DropdownMenuItem asChild>
                            <button type="submit" className="w-full text-left">Extend Trial +30 Days</button>
                          </DropdownMenuItem>
                        </form>
                        {(customer.status ?? "").toLowerCase() === "archived" ? (
                          <form action={onSetStatus}>
                            <input type="hidden" name="orgId" value={customer.id} />
                            <input type="hidden" name="status" value="active" />
                            <input type="hidden" name="reason" value="Unarchived from customers page." />
                            <DropdownMenuItem asChild>
                              <button type="submit" className="w-full text-left">Unarchive Organization</button>
                            </DropdownMenuItem>
                          </form>
                        ) : (
                          <form action={onSetStatus}>
                            <input type="hidden" name="orgId" value={customer.id} />
                            <input type="hidden" name="status" value="archived" />
                            <input type="hidden" name="reason" value="Archived from customers page." />
                            <DropdownMenuItem asChild>
                              <button type="submit" className="w-full text-left">Archive Organization</button>
                            </DropdownMenuItem>
                          </form>
                        )}
                        <DropdownMenuItem onClick={() => handleViewCustomer(customer)}>
                          View Details
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer font-medium"
                          onClick={() => {
                            setCustomerToDelete(customer)
                            setDeleteConfirmationText("")
                          }}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete Organization
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      {(hasNextPage || hasPrevPage) && (
        <div className="flex justify-between items-center">
          <Button
            variant="outline"
            disabled={!hasPrevPage}
            asChild={hasPrevPage}
          >
            {hasPrevPage ? (
              <Link href={`/admin/customers?page=${page - 1}&search=${search}&status=${status}&plan=${plan}`}>
                Previous
              </Link>
            ) : (
              <span>Previous</span>
            )}
          </Button>

          <div className="text-sm text-muted-foreground">
            Page {page} • {totalCount} total customers
          </div>

          <Button
            variant="outline"
            disabled={!hasNextPage}
            asChild={hasNextPage}
          >
            {hasNextPage ? (
              <Link href={`/admin/customers?page=${page + 1}&search=${search}&status=${status}&plan=${plan}`}>
                Next
              </Link>
            ) : (
              <span>Next</span>
            )}
          </Button>
        </div>
      )}

      <CustomerSheet
        customer={selectedCustomer}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onUpdateCustomer={onUpdateCustomer}
      />

      <Dialog open={Boolean(billingCustomer)} onOpenChange={(open) => !open && setBillingCustomer(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Billing</DialogTitle>
            <DialogDescription>
              Update Arc's local subscription record for {billingCustomer?.name}. Stripe remains the source of truth for payment collection.
            </DialogDescription>
          </DialogHeader>
          {billingCustomer ? (
            <form onSubmit={handleBillingSubmit} className="space-y-5">
              <input type="hidden" name="orgId" value={billingCustomer.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="billing-status">Status</Label>
                  <Select name="status" value={billingStatus} onValueChange={setBillingStatus}>
                    <SelectTrigger id="billing-status" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="trialing">Trialing</SelectItem>
                      <SelectItem value="past_due">Past due</SelectItem>
                      <SelectItem value="canceled">Canceled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="billing-plan">Plan</Label>
                  <Select name="planCode" defaultValue={billingCustomer.subscription?.planCode ?? "__none"}>
                    <SelectTrigger id="billing-plan" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">No plan</SelectItem>
                      {subscriptionPlans.map((subscriptionPlan) => (
                        <SelectItem key={subscriptionPlan.code} value={subscriptionPlan.code}>
                          {subscriptionPlan.name}
                          {subscriptionPlan.amountCents ? ` - $${(subscriptionPlan.amountCents / 100).toFixed(0)}` : ""}
                          {subscriptionPlan.interval ? `/${subscriptionPlan.interval}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="current-period-end">Current period end</Label>
                  <Input
                    id="current-period-end"
                    name="currentPeriodEnd"
                    type="date"
                    defaultValue={toDateInputValue(billingCustomer.subscription?.currentPeriodEnd)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="trial-ends-at">Trial ends</Label>
                  <Input
                    id="trial-ends-at"
                    name="trialEndsAt"
                    type="date"
                    defaultValue={toDateInputValue(billingCustomer.subscription?.trialEndsAt)}
                    disabled={billingStatus === "active"}
                  />
                  {billingStatus === "active" ? (
                    <p className="text-xs text-muted-foreground">Active subscriptions clear the trial end date.</p>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="stripe-customer-id">Stripe customer ID</Label>
                  <Input
                    id="stripe-customer-id"
                    name="externalCustomerId"
                    placeholder="cus_..."
                    defaultValue={billingCustomer.subscription?.externalCustomerId ?? ""}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="stripe-subscription-id">Stripe subscription ID</Label>
                  <Input
                    id="stripe-subscription-id"
                    name="externalSubscriptionId"
                    placeholder="sub_..."
                    defaultValue={billingCustomer.subscription?.externalSubscriptionId ?? ""}
                  />
                </div>
              </div>

              <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
                Use this for manual reconciliation only. It updates Arc's local subscription row; it does not create, cancel, or edit a Stripe subscription.
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setBillingCustomer(null)} disabled={savingBilling}>
                  Cancel
                </Button>
                <Button type="submit" disabled={savingBilling}>
                  {savingBilling ? "Saving..." : "Save Billing"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(activateCustomer)} onOpenChange={(open) => !open && setActivateCustomer(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Activate billing</DialogTitle>
            <DialogDescription>
              Create the custom Stripe price and billing setup for {activateCustomer?.name}.
            </DialogDescription>
          </DialogHeader>
          {activateCustomer ? (
            <form onSubmit={handleActivateBillingSubmit} className="space-y-5">
              <input type="hidden" name="orgId" value={activateCustomer.id} />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="activate-amount">Amount</Label>
                  <Input id="activate-amount" name="amountDollars" type="number" min="1" step="1" placeholder="2500" required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="activate-interval">Interval</Label>
                  <Select name="interval" defaultValue="month">
                    <SelectTrigger id="activate-interval">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="month">Monthly</SelectItem>
                      <SelectItem value="year">Annual</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="activate-method">Payment method</Label>
                <Select name="collectionMethod" value={activationMethod} onValueChange={(value) => setActivationMethod(value as "checkout" | "invoice")}>
                  <SelectTrigger id="activate-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="checkout">Card - send checkout link</SelectItem>
                    <SelectItem value="invoice">ACH invoice - Stripe emails it</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {activationMethod === "invoice" ? (
                <div className="space-y-2">
                  <Label htmlFor="activate-net-days">Net days</Label>
                  <Input id="activate-net-days" name="netDays" type="number" min="1" max="90" defaultValue="30" />
                </div>
              ) : null}

              {activationResult ? (
                <div className="border bg-muted/20 px-4 py-3 text-sm">
                  <p className="font-medium">{activationResult.message}</p>
                  {activationResult.checkoutUrl ? (
                    <div className="mt-3 flex gap-2">
                      <Input value={activationResult.checkoutUrl} readOnly />
                      <Button type="button" variant="outline" size="icon" onClick={() => copyPaymentLink(activationResult.checkoutUrl)} aria-label="Copy payment link">
                        <Copy />
                      </Button>
                      <Button type="button" variant="outline" size="icon" asChild aria-label="Open payment link">
                        <a href={activationResult.checkoutUrl} target="_blank" rel="noreferrer">
                          <ExternalLink />
                        </a>
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setActivateCustomer(null)} disabled={activatingBilling}>
                  Close
                </Button>
                <Button type="submit" disabled={activatingBilling}>
                  {activatingBilling ? "Activating..." : "Activate Billing"}
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(customerToDelete)} onOpenChange={(open) => !open && setCustomerToDelete(null)}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive flex items-center gap-2">
              <Trash2 className="h-5 w-5" />
              Delete Organization?
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <div>
                Are you sure you want to delete the organization <span className="font-semibold text-foreground">"{customerToDelete?.name}"</span>?
              </div>
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-lg border border-destructive/20 font-medium">
                WARNING: This is extremely destructive and cannot be undone. This will permanently delete the organization, all of its projects, memberships, subscriptions, licenses, files, and all associated data.
              </div>
              <div className="space-y-1.5 pt-2">
                <label className="text-xs font-semibold text-muted-foreground">
                  To confirm, type <span className="font-mono text-foreground font-bold select-all">"{customerToDelete?.name}"</span> below:
                </label>
                <Input
                  value={deleteConfirmationText}
                  onChange={(e) => setDeleteConfirmationText(e.target.value)}
                  placeholder="Enter organization name"
                  className="w-full"
                  disabled={deleting}
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} onClick={() => setDeleteConfirmationText("")}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                handleDeleteCustomer()
              }}
              disabled={deleting || deleteConfirmationText !== customerToDelete?.name}
            >
              {deleting ? "Deleting..." : "Delete Organization"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function toDateInputValue(value?: string | null) {
  return value ? value.slice(0, 10) : ""
}

function getStatusVariant(status: string) {
  switch (status) {
    case 'active':
      return 'default'
    case 'inactive':
      return 'secondary'
    case 'suspended':
      return 'destructive'
    default:
      return 'outline'
  }
}
