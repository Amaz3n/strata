import Link from "next/link"

export default function AdministrationOverviewArticle() {
  return (
    <>
      <p>
        Workspace Administration is the central hub for managing your company&apos;s account in Arc. 
        It gives company owners, executives, and designated administrators control over organizational settings, 
        user security permissions, subscription billing, and external accounting integrations. 
        Setting up these defaults correctly ensures that your projects run smoothly, brand guidelines are met, 
        and financial data is secure.
      </p>

      <h2>Key Administrative Controls</h2>
      <p>
        Workspace administrative workflows are divided into three core categories:
      </p>

      <h3>1. Company Profile &amp; Project Defaults</h3>
      <p>
        Navigate to <strong>Settings → Profile</strong> to configure standard configurations that apply across all projects:
      </p>
      <ul>
        <li>
          <strong>Branding &amp; Logos:</strong> Upload your company logo and select your brand color. This logo automatically appears on all customer-facing PDF exports, submittals, RFI sheets, budget reports, and in the Client and Subcontractor Portals.
        </li>
        <li>
          <strong>Standard CSI Cost Codes:</strong> Pre-populate your workspace with standard CSI Division codes (16-Division or 50-Division templates) or upload your custom corporate chart of accounts. This structure serves as the foundation for building new project budgets.
        </li>
        <li>
          <strong>Document Templates:</strong> Define default contract terms for subcontracts and purchase orders, and upload standard lien waiver templates to automate verification processes.
        </li>
      </ul>

      <h3>2. Team &amp; Access Controls</h3>
      <p>
        Invite your team, manage user roles, and apply fine-grained permission overrides to control who can view financial details or approve daily logs.
        {" "}
        <Link href="/help/workspace-administration/settings-and-access/team-permissions">
          Read the Team &amp; Permissions Guide
        </Link>
        .
      </p>

      <h3>3. Subscription &amp; Billing</h3>
      <p>
        Update payment methods via Stripe, download historical Arc invoices, and manage QuickBooks Online integration sync statuses.
        {" "}
        <Link href="/help/workspace-administration/settings-and-access/subscription-billing">
          Read the Subscription &amp; Billing Guide
        </Link>
        .
      </p>
    </>
  )
}
