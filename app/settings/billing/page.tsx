import { AppShell } from "@/components/layout/app-shell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { getCurrentUserAction } from "@/app/actions/user"
import { getOrgBilling } from "@/lib/services/orgs"
import { requirePermissionGuard } from "@/lib/auth/guards"

export default async function BillingPage() {
  await requirePermissionGuard("billing.manage")
  const [currentUser, billing] = await Promise.all([getCurrentUserAction(), getOrgBilling()])

  const status = billing.subscription?.status ?? "active"
  const renewal = billing.subscription?.current_period_end
  const planName = billing.plan?.name ?? billing.subscription?.plan_code ?? billing.org.billing_model ?? "Custom"

  return (
    <AppShell title="Billing" user={currentUser}>
      <div className="p-4 lg:p-6 space-y-6">
        <div>
          <h1 className="text-2xl font-bold">Billing</h1>
          <p className="text-muted-foreground mt-1">Subscription details for this organization.</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Plan</CardTitle>
            <CardDescription>Currently assigned plan and status.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-lg font-semibold">{planName}</span>
              <Badge variant="outline">{billing.plan?.pricing_model ?? "subscription"}</Badge>
              <Badge variant={status === "active" ? "default" : "outline"} className="capitalize">
                {status}
              </Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              Interval: {billing.plan?.interval ?? "monthly"} • Amount:{" "}
              {billing.plan?.amount_cents != null
                ? `$${(billing.plan.amount_cents / 100).toFixed(2)} ${billing.plan.currency ?? "usd"}`
                : "Custom / invoiced"}
            </div>
            {renewal && (
              <div className="text-sm text-muted-foreground">
                Current period ends: {new Date(renewal).toLocaleDateString()}
              </div>
            )}
            {billing.subscription?.external_customer_id && (
              <div className="text-sm text-muted-foreground">
                External customer: {billing.subscription.external_customer_id}
              </div>
            )}
            {billing.subscription?.external_subscription_id && (
              <div className="text-sm text-muted-foreground">
                Invoice/subscription ref: {billing.subscription.external_subscription_id}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  )
}



