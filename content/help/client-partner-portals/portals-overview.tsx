import Link from "next/link"

export default function PortalsOverviewArticle() {
  return (
    <>
      <p>
        Arc Portals provide clients, subcontractors, vendors, and bidders with controlled, secure access to the 
        specific information and actions intended for them. This keeps external stakeholders updated and active 
        without exposing your internal company workspace.
      </p>

      <h2>Core Portal Experiences</h2>
      <p>
        Arc includes three main portal modules. Click the detailed guides below to learn how each portal works 
        and how to manage them:
      </p>

      <h3>1. Client Portal</h3>
      <p>
        Share schedules, site photos, daily logs, and open-book budgets with project owners. Allow clients to submit 
        design selections, approve change orders, pay invoices via Stripe, and lodge warranty requests.
        {" "}
        <Link href="/help/client-and-partner-portals/external-access/client-portal">
          Read the Client Portal Guide
        </Link>
        .
      </p>

      <h3>2. Subcontractor Portal</h3>
      <p>
        Enable subcontractors to view active commitments (subcontracts), submit monthly progress bills, upload 
        insurance compliance documents, answer assigned RFIs, and resolve punch list items.
        {" "}
        <Link href="/help/client-and-partner-portals/external-access/subcontractor-portal">
          Read the Subcontractor Portal Guide
        </Link>
        .
      </p>

      <h3>3. Bid, Proposal, &amp; Invoice Portals</h3>
      <p>
        Manage preconstruction bid packages, distribute specs, collect early trade pricing, send contracts for client 
        electronic signature, and email invoices with secure Stripe billing links.
        {" "}
        <Link href="/help/client-and-partner-portals/external-access/bid-proposal-portals">
          Read the Bid &amp; Proposal Portals Guide
        </Link>
        .
      </p>
    </>
  )
}
