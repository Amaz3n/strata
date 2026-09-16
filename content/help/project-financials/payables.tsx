export default function PayablesArticle() {
  return (
    <>
      <p>
        Payables is the operating desk for vendor bills. Start with the bill and its supporting document,
        then move through coding, review, approvals, holds, payment, and accounting follow-through without
        losing the decision history.
      </p>

      <h2>The payable lifecycle</h2>
      <ul>
        <li><strong>Capture:</strong> Add a bill directly or bring the source document into the Cost Inbox for review.</li>
        <li><strong>Code and verify:</strong> Assign the vendor, project, cost coding, amount, due date, and any commitment context before requesting approval.</li>
        <li><strong>Approve:</strong> Arc routes a ready bill through the required review. Your workspace may also have rules that auto-approve eligible bills.</li>
        <li><strong>Hold or release:</strong> Compliance, lien-waiver, retainage, and payment-control checks can keep an otherwise approved bill out of a payment run.</li>
        <li><strong>Pay and reconcile:</strong> Approved, eligible bills can be added to an Arc Pay run or managed using your organization&apos;s other accounting process.</li>
      </ul>

      <h2>Review a bill before approving it</h2>
      <p>
        Open the payable workspace and use the document, identity, amount, lines, terms, approvals, and
        timeline sections as one review packet. Confirm that the vendor and project are correct, that line
        totals match the document, and that the coding reflects the cost you intend to report.
      </p>

      <h2>Resolve holds instead of working around them</h2>
      <p>
        A hold is an explicit reason that money cannot move. Review the hold on the payable, correct the
        underlying compliance record, waiver, retainage, or payment-control issue, then return to the bill.
        Do not create a duplicate bill or move it to another vendor just to bypass a control.
      </p>
      <blockquote>
        The approval route and timeline preserve who acted, what was changed, and why a bill was held or
        released. Use that record when answering a vendor question or investigating an exception.
      </blockquote>

      <h2>Send approved bills to payment</h2>
      <p>
        Build a payment run from eligible bills, review the amount and vendor readiness, and submit it for
        the approval required by your organization. The payment run—not an individual bill—is the unit that
        releases money. See <strong>Payment runs &amp; approvals</strong> for the release controls and
        <strong> Payment reconciliation exceptions</strong> for post-payment follow-up.
      </p>
    </>
  )
}
