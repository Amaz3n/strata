import Link from "next/link"

export default function StripePaymentsArticle() {
  return (
    <>
      <p>
        Arc integrates with Stripe to enable secure, online invoice payments. By setting up Stripe, you can 
        allow clients to pay progress invoices or cost-plus draws directly inside their secure Client Portal 
        using credit cards, debit cards, or ACH bank transfers.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Stripe Express Onboarding:</strong> Connect your bank account and verify company credentials using a secure onboarding flow.</li>
        <li><strong>Flexible Payment Methods:</strong> Enable Credit Card (Visa, Mastercard, Amex, Discover) and ACH bank transfers.</li>
        <li><strong>ACH Verification:</strong> Automate secure bank connection using Stripe Instant Verification or micro-deposits.</li>
        <li><strong>Automated Payouts:</strong> Funds paid by clients are deposited directly into your linked business bank account.</li>
        <li><strong>Instant Payments:</strong> Webhooks listen to Stripe events to instantly update invoices to **Paid** when the transaction completes.</li>
      </ul>

      <h2>Setting Up Stripe</h2>
      <p>
        To set up online payments, navigate to <strong>Settings → Integrations</strong>:
      </p>
      <ol>
        <li>Click <strong>Connect Stripe</strong>. You will be redirected to Stripe&apos;s onboarding page.</li>
        <li>Provide your business details (legal name, EIN, address) and bank routing/account numbers.</li>
        <li>Once completed, you are redirected back to Arc, and your account status will show as <strong>Connected</strong>.</li>
      </ol>
      <blockquote>
        <strong>Note:</strong> You can select whether to accept Credit Cards, ACH, or both. Because credit card fees 
        are higher, many builders prefer to accept ACH payments only for large contract draws.
      </blockquote>

      <h2>The Client Billing Experience</h2>
      <p>
        When you email a client invoice, the secure link opens their invoice page. 
      </p>
      <ul>
        <li>If Stripe is connected, the portal displays a **Pay Online** button.</li>
        <li>Clients select their payment method. If choosing ACH, they can securely sign into their bank account to verify funds instantly.</li>
        <li>Once the payment is submitted, Stripe processes the transaction. When successful, the invoice status in Arc updates to **Paid** and notifies your team. Payouts are deposited in your bank account according to your Stripe schedule.</li>
      </ul>
    </>
  )
}
