import Link from "next/link"

export default function IntegrationSyncIssuesArticle() {
  return (
    <>
      <p>
        Arc integrates directly with QuickBooks Online (QBO) for accounting sync and Stripe for secure credit card and ACH payment processing. 
        Because these services communicate in real-time, validation rules or token expirations can sometimes interrupt synchronization. 
        Follow this guide to debug and resolve integration errors.
      </p>

      <h2>QuickBooks Online (QBO) Sync Failures</h2>
      <p>
        To review failed sync events, navigate to your project&apos;s <strong>Financials</strong>, locate the failed bill or invoice, and click the red <strong>Sync Error</strong> status badge.
      </p>

      <h3>Issue 1: Expired Connection Token (Authentication Errors)</h3>
      <p>
        <strong>Symptom:</strong> The error log displays <code>Authentication failed</code>, <code>Token invalid</code>, or <code>Token expired</code>.
      </p>
      <ul>
        <li><strong>Root Cause:</strong> QBO security authorizations expire periodically (typically every 100 days), or when your QuickBooks administrator credentials change.</li>
        <li><strong>Resolution:</strong> A Workspace Administrator must navigate to <strong>Settings → Integrations</strong>, click <strong>Reconnect QuickBooks</strong>, and follow the Intuit prompt to log in and authorize the connection.</li>
      </ul>

      <h3>Issue 2: Duplicate Document Number Violation</h3>
      <p>
        <strong>Symptom:</strong> The sync error log displays <code>Duplicate Document Number Error: The name/number entered is already in use.</code>
      </p>
      <ul>
        <li><strong>Root Cause:</strong> QuickBooks is configured to block duplicate invoice or vendor bill numbers to prevent double-payment. If a vendor has already submitted a bill numbered <code>INV-999</code> and it exists in QBO, Arc cannot sync another bill with the same identifier.</li>
        <li><strong>Resolution:</strong>
          <ul>
            <li>In Arc, open the bill details and modify the bill reference number (e.g., changing <code>INV-999</code> to <code>INV-999-A</code> or appending the project number).</li>
            <li>Alternatively, log into QBO and adjust your billing preferences under <strong>Account and Settings → Advanced → Transactions</strong> to turn off the warning/block for duplicate numbers.</li>
          </ul>
        </li>
      </ul>

      <h3>Issue 3: Missing Accounts, Products, or Services in Dropdowns</h3>
      <p>
        <strong>Symptom:</strong> When trying to code a bill or invoice, a specific QuickBooks Chart of Accounts code or Product/Service item is missing from the Arc dropdown menu.
      </p>
      <ul>
        <li><strong>Root Cause:</strong> To optimize speed, Arc caches your QBO Chart of Accounts. If you add a new account in QuickBooks, it won&apos;t appear in Arc immediately.</li>
        <li><strong>Resolution:</strong> Navigate to <strong>Settings → Integrations</strong> and click <strong>Refresh QuickBooks Data Cache</strong>. This triggers an API call that syncs your active Chart of Accounts, Products/Services, and Tax Codes instantly.</li>
      </ul>

      <h3>Issue 4: Unmapped Subcontractor or Project Customer</h3>
      <p>
        <strong>Symptom:</strong> The sync fails stating <code>Subcontractor is not mapped to a QBO Vendor</code> or <code>Project is not mapped to a QBO Customer/Job</code>.
      </p>
      <ul>
        <li><strong>Resolution:</strong>
          <ul>
            <li><strong>For Subcontractors:</strong> Go to the <strong>Directory</strong> tab, select the company profile, click <strong>Edit Details</strong>, and select the corresponding QuickBooks Vendor from the dropdown menu to link their records.</li>
            <li><strong>For Projects:</strong> Go to <strong>Settings → Project Details</strong>, find the QuickBooks mapping dropdown, and choose the correct QuickBooks Customer or sub-customer/job.</li>
          </ul>
        </li>
      </ul>

      <h2>Stripe Payment and Payout Failures</h2>
      <p>
        Arc utilizes Stripe Express to process payments from clients.
      </p>

      <h3>Issue 1: Stripe Payouts Placed on Hold</h3>
      <p>
        <strong>Symptom:</strong> Clients can pay you, but funds are not depositing into your bank account, and your Stripe Express dashboard shows a <code>Payouts Restricted</code> alert.
      </p>
      <ul>
        <li><strong>Root Cause:</strong> Stripe enforces regulatory Know Your Customer (KYC) requirements. If your processing volume hits certain thresholds, Stripe pauses payouts until you upload additional verification files.</li>
        <li><strong>Resolution:</strong> Go to <strong>Settings → Integrations</strong>, click <strong>Stripe Dashboard</strong>, and verify your account identity. You may need to upload a photo ID, an EIN validation letter from the IRS (Form CP575), or proof of address.</li>
      </ul>

      <h3>Issue 2: Client ACH Bank Verification Delays</h3>
      <p>
        <strong>Symptom:</strong> Client tries to pay their invoice draw via bank transfer, but cannot complete the payment.
      </p>
      <ul>
        <li><strong>Root Cause:</strong> Bank transfers (ACH) require bank account verification to prevent fraud. If instant bank login/verification fails or is not supported by the client&apos;s bank, they must verify their bank account manually.</li>
        <li><strong>Resolution:</strong> The client can choose <strong>Verify via Micro-deposits</strong>. Stripe will deposit two micro-amounts (less than $1.00) into the client&apos;s bank account within 1-2 business days. The client must check their bank statement, log back into the invoice payment portal, and enter those exact amounts to authorize payment.</li>
      </ul>
    </>
  )
}
