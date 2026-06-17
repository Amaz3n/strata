import Link from "next/link"

export default function BidsArticle() {
  return (
    <>
      <p>
        Arc&apos;s Bids tool streamlines the preconstruction and procurement phases. It allows general contractors 
        to create detailed bid packages, invite trade partners from their directory, distribute project files, 
        and compare incoming subcontractor proposals side-by-side.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Bid Packages:</strong> Organize procurement by scope of work, cost code, or trade. Specify instructions, scopes, and target deadlines.</li>
        <li><strong>Subcontractor Invites:</strong> Select companies and contacts from your directory to invite. Arc handles invitation emails and tracks access statistics.</li>
        <li><strong>Secure Bid Portal:</strong> Subcontractors receive secure, passwordless links to a portal where they can view plans, download specs, and submit proposals.</li>
        <li><strong>Bid Addenda:</strong> Issue updates or add additional documents to active bid packages. Invited subcontractors are automatically notified.</li>
        <li><strong>Awarding & Commitments:</strong> Review submissions, select the winning bid, and automatically award the contract, creating a commitment in your project financials.</li>
      </ul>

      <h2>Setting Up a Bid Package</h2>
      <p>
        To start a bidding process, navigate to the <strong>Bids</strong> page of your project and click <strong>Create Bid Package</strong>.
      </p>
      <ol>
        <li><strong>Title and Trade:</strong> Provide a descriptive name (e.g., <code>Concrete &amp; Foundations</code>) and choose the primary trade.</li>
        <li><strong>Cost Code:</strong> Link the package to a project cost code to keep your budget aligned.</li>
        <li><strong>Scope & Instructions:</strong> Outline the scope of work and clarify submission requirements.</li>
        <li><strong>Due Date:</strong> Set the bidding deadline. Subcontractors will see a countdown in their portal.</li>
      </ol>

      <h2>Inviting Subcontractors</h2>
      <p>
        Once the package is created, click <strong>Invite Subcontractors</strong>. Search your company directory for 
        trade partners and select the contacts you wish to invite.
      </p>
      <blockquote>
        <strong>Note:</strong> When you send invites, Arc emails each subcontractor a secure link. They do not 
        need an Arc account to access their bid portal, view documents, or upload their proposal.
      </blockquote>
      <p>
        In the bid package dashboard, you can monitor invitation status (e.g., Sent, Viewed, Declined, Submitted) 
        and see how many times each trade partner has accessed the documents.
      </p>

      <h2>Issuing Addenda</h2>
      <p>
        If plans change or you need to clarify a question for all bidders, use the <strong>Addenda</strong> feature. 
        Click <strong>Issue Addendum</strong>, enter a title, type your update message, and attach any new files. 
        Arc will instantly email all invited subcontractors and update the documents in their portals.
      </p>

      <h2>Reviewing and Awarding Bids</h2>
      <p>
        Subcontractors submit proposals detailing their bid price, exclusions, clarifications, lead times, and notes. 
        You can view all submissions in a clean comparison grid.
      </p>
      <p>
        When you make a selection, click <strong>Award Bid</strong>. Arc will mark the bid as awarded and run a conversion 
        to create a subcontract or commitment under your <strong>Financials</strong> module, carrying over all pricing and 
        scope descriptions.
      </p>
    </>
  )
}
