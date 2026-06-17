import Link from "next/link"

export default function ClientPortalArticle() {
  return (
    <>
      <p>
        The Client Portal provides project owners and clients with a clean, branded dashboard to monitor project 
        progress, view photos, download files, approve change orders, make selections, and pay invoices online.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Controlled Visibility:</strong> Select exactly what your client can see, including schedule tasks, daily logs, budget lines, and documents.</li>
        <li><strong>Interactive Selections:</strong> Clients submit design finish selections and approvals directly from the portal.</li>
        <li><strong>Change Order Approvals:</strong> Clients review, decline, or electronically sign Owner Change Orders (OCOs).</li>
        <li><strong>Online Payments:</strong> Clients pay progress invoices or draw billings securely using credit card or ACH.</li>
        <li><strong>Warranty Lodging:</strong> Clients submit post-occupancy warranty requests and monitor their status.</li>
      </ul>

      <h2>Configuring Client Permissions</h2>
      <p>
        To share a portal link, navigate to your project dashboard, click <strong>Share</strong>, and select 
        <strong>Client Portal</strong>. You can customize the permissions for the invitation link:
      </p>
      <ul>
        <li><strong>View Schedule &amp; Logs:</strong> Show the project calendar, timeline Gantt items, or approved superintendent daily logs.</li>
        <li><strong>View Documents:</strong> Share folders from your project Documents library. You can allow or block file downloads.</li>
        <li><strong>View Budget (Open Book):</strong> If enabled, the client can view transaction actuals, vendor bills, and timesheets side-by-side with budget lines.</li>
        <li><strong>Approve Change Orders &amp; Selections:</strong> Grant approval rights for OCOs and design selections.</li>
        <li><strong>Pay Invoices:</strong> Enable clients to execute credit card or ACH payments.</li>
      </ul>

      <h2>The Client Portal Experience</h2>
      <p>
        Clients open their portal using a secure link emailed from Arc. To ensure security, you can enforce 
        <strong>PIN Authentication</strong> (requiring the client to enter a 4-digit PIN) or enforce **Account Requirements** 
        (requiring them to set up an email/password account).
      </p>
      <p>
        Inside the portal, clients can interact with:
      </p>
      <ul>
        <li><strong>Progress &amp; Photos:</strong> View the current schedule status and check out site photos uploaded by your field team.</li>
        <li><strong>Selections &amp; Decisions:</strong> Review available tile, appliance, or paint options, see price adjustments, and approve their final selections.</li>
        <li><strong>Change Orders:</strong> Review proposed change order details, see timeline adjustments, and sign them electronically.</li>
        <li><strong>Invoices &amp; Receivables:</strong> View current outstanding balances and pay online using Stripe, downloading copies of payment receipts instantly.</li>
        <li><strong>Warranty:</strong> After handover, the portal transitions to closeout mode, letting clients log defect tickets and request warranty service.</li>
      </ul>
    </>
  )
}
