import Link from "next/link"

export default function DecisionsArticle() {
  return (
    <>
      <p>
        The Decisions tool manages formal selections and authorizations, such as design selections, 
        material finishes, or scope choices. It provides a structured workflow to log a request, assign it to a 
        client or architect, track their response, and lock in the final direction.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Selection Logging:</strong> Record the options available, specifications, cost differences, and descriptions.</li>
        <li><strong>Due Dates:</strong> Assign deadlines to selections to prevent lead-time delays or fabrication holdups.</li>
        <li><strong>Formal Approvals:</strong> Record who approved the decision and the exact date and time it occurred.</li>
        <li><strong>Project History:</strong> Build an audit trail of all approved directions to resolve scope disputes.</li>
      </ul>

      <h2>Creating a Decision Request</h2>
      <p>
        To log a selection or decision request, navigate to the <strong>Decisions</strong> page under your project 
        and click <strong>New Decision Request</strong>.
      </p>
      <ol>
        <li><strong>Title:</strong> Name the selection (e.g., <code>Lobby floor tile selection</code>).</li>
        <li><strong>Description:</strong> Describe the choice, list the options (e.g., Option A: Carrera Marble, Option B: Porcelain Tile), and attach spec sheets or images.</li>
        <li><strong>Due Date:</strong> Set a target date. Delayed decisions are flagged to prevent critical path slippage on the schedule.</li>
      </ol>

      <h2>Approving Decisions</h2>
      <p>
        When a client or architect makes their choice:
      </p>
      <ul>
        <li>Open the decision request and click <strong>Approve Decision</strong>.</li>
        <li>Update the status to <strong>Approved</strong>.</li>
        <li>This logs the approval timestamp and links the user who made the selection as the approver.</li>
      </ul>
      <blockquote>
        <strong>Tip:</strong> If an approved decision changes the contract price or scope, the decision notes can 
        be referenced directly when creating a corresponding change order in your project financials.
      </blockquote>
    </>
  )
}
