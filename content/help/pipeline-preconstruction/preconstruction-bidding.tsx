import Link from "next/link"

export default function PreconstructionBiddingArticle() {
  return (
    <>
      <p>
        Preconstruction Bidding allows estimating teams to issue bid packages, distribute drawings, and collect 
        pricing from trade partners before a project is officially won or active. This ensures your bid estimates 
        are backed by real subcontractor commitments.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Early Bid Packages:</strong> Create bid packages scoped by cost code or trade under your active CRM prospects.</li>
        <li><strong>Subcontractor Portal:</strong> Invite subcontractors to access bid documents, review preconstruction drawings, and submit proposals.</li>
        <li><strong>Pricing Alignment:</strong> Pull subcontractor bid prices directly into your active preconstruction estimates.</li>
        <li><strong>Automatic Project Promotion:</strong> All bid packages, invites, and subcontractor submissions automatically transfer to the active project once the job is won.</li>
      </ul>

      <h2>Bidding During Preconstruction</h2>
      <p>
        To run a preconstruction bid, navigate to the **Bids** tab of a prospect and click <strong>Create Bid Package</strong>.
      </p>
      <ol>
        <li>Define the trade (e.g., <code>Concrete</code>) and link it to a cost code.</li>
        <li>Upload preconstruction drawing sets and specifications.</li>
        <li>Select subcontractors from your directory and send invites. Bidders will receive an email invitation directing them to their secure bid portal.</li>
      </ol>
      <blockquote>
        <strong>Note:</strong> Preconstruction bids work identically to project-level bids, ensuring subcontractors have a consistent, passwordless experience when viewing documents and uploading proposals.
      </blockquote>

      <h2>Aligning Estimates with Bids</h2>
      <p>
        As subcontractors submit proposals, you can compare pricing and select the most competitive bids. You can 
        reference subcontractor pricing directly when adjusting your client-facing estimates, ensuring your proposed 
        contract sum is accurate and profitable.
      </p>

      <h2>Project Promotion Transition</h2>
      <p>
        When a prospect is successfully promoted to a project:
      </p>
      <ul>
        <li>You do <em>not</em> need to recreate bid packages.</li>
        <li>Arc automatically re-scopes the bid package data to the newly created project.</li>
        <li>All invite records, views, addenda, and subcontractor submissions are carried over, preserving the preconstruction audit trail.</li>
      </ul>
    </>
  )
}
