import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import { SubscriptionPlansClient } from "@/components/admin/subscription-plans-client"
import { CustomersClient } from "@/components/admin/customers-table"
import { PaymentRunActionsPanel } from "@/components/payables/payment-run-actions-panel"

const plan = { code: "fixture", name: "Fixture plan", publicName: null, packageType: null, featureKeys: [], internalNotes: null, pricingModel: "subscription", interval: "month", amountCents: 1000, currency: "usd", isActive: true, createdAt: "2026-01-01" }
const customer = { id: "fixture", name: "Fixture customer", slug: "fixture", status: "active", billingModel: "subscription", billingEmail: null, productTier: "residential", memberCount: 1, createdAt: "2026-01-01", health: { lastActivityAt: null, activeMemberCount: 1, projectCount: 0, eventsLast14d: 0, storageBytes: 0, qboStatus: null, atRisk: false }, subscription: null }
function Fixture() {
  const [plans, setPlans] = useState([plan])
  const [customers, setCustomers] = useState([customer])
  const [search, setSearch] = useState("")
  useEffect(() => {
    window.adminFixture = { refreshPlans: () => setPlans([{ ...plan, name: "Updated plan" }]), refreshCustomer: () => setCustomers([{ ...customer, name: "Updated customer" }]), restoreSearch: () => setSearch("Restored") }
  }, [])
  const kind = new URLSearchParams(location.search).get("kind")
  if (kind === "plans") return <SubscriptionPlansClient plans={plans} />
  if (kind === "customers") return <CustomersClient customers={customers} totalCount={1} hasNextPage={false} hasPrevPage={false} search={search} status="all" plan="all" page={1} subscriptionPlans={[]} onUpdateCustomer={async data => { window.savedCustomer = Object.fromEntries(data); }} onActivateBilling={async () => ({})} onUpdateSubscription={async () => {}} onExtendTrial={async () => {}} onEnterContext={async () => {}} onSetStatus={async () => {}} />
  return <PaymentRunActionsPanel run={{ id: "run", status: "approved", content_hash: "hash", can_approve: true, can_cancel: true, paymentCount: 1 }} />
}
createRoot(document.getElementById("root")).render(<Fixture />)
