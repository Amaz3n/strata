export default function PaymentRunsApprovalsArticle() {
  return (
    <>
      <p>
        A payment run is a batch of approved payables released together. It is the point where money actually
        leaves your bank, so it carries more ceremony than anything else in Arc: a frozen set of bills, a
        recorded approval, and a debit that cannot be recalled the way a check can be stopped.
      </p>

      <h2>Building a run</h2>
      <p>
        Runs are built on the <strong>Payables</strong> desk. Select the bills you intend to pay and choose to pay
        them with Arc Pay. Arc checks each one before it will accept it:
      </p>
      <ul>
        <li>The vendor is verified and their Arc Pay access is active.</li>
        <li>The bill is approved and not blocked by a compliance, insurance, or lien-waiver hold.</li>
        <li>The amount fits your per-payment, per-run, daily, and in-flight limits.</li>
        <li>The bill is not already sitting in another live run.</li>
      </ul>
      <p>
        You can schedule a run for a future date. The scheduled date is part of what gets approved — changing it
        changes the run, and a changed run needs its approvals again.
      </p>

      <h2>What gets frozen at submission</h2>
      <p>
        Submitting a run takes a fingerprint of exactly what it contains: the bills, the amounts, the vendors,
        the retainage held, the fees, and the schedule. Approvers approve that fingerprint. If anything in the
        run changes afterwards, the previous approvals no longer apply and the run has to be approved again.
      </p>
      <p>
        This is why the approval email states the amount, the vendor count, the funding bank, and who prepared
        it. An approver should never have to open the app to learn what they are approving — though the decision
        itself is always recorded in Arc, never by replying to an email.
      </p>

      <h2>Sole approval and dual approval</h2>
      <p>
        Your organization chooses one mode in <strong>Settings → Payments</strong>:
      </p>
      <ul>
        <li>
          <strong>Sole approval</strong> — one approval releases the run. Appropriate for small teams where the
          same person owns AP end to end.
        </li>
        <li>
          <strong>Dual approval</strong> — two different people must approve before anything moves. This is the
          control that stops a single compromised account, or a single mistake, from emptying a bank account.
        </li>
      </ul>
      <p>
        Under dual approval, Arc does not release on the first approval. The preparer is told an approval was
        recorded, and the run waits.
      </p>

      <h2>Why you cannot approve your own run</h2>
      <p>
        The person who builds a run is not one of its approvers. Separating preparation from approval is the
        whole point of the control: if the same person can add a vendor, add a bill, and release the money, then
        nothing in the process is actually checked by anyone. It also means a compromised account cannot both
        create and release a payment.
      </p>
      <p>
        There is one narrow exception. An organization explicitly configured as owner-operated — a single person
        who genuinely is the whole finance function — can be set to allow the requester to approve. That setting
        is deliberate, visible in your payment settings, and recorded in the audit log. It is not a default and
        should not be used to work around a busy approver.
      </p>
      <blockquote>
        If a run is stuck because the only approver is unavailable, add an approver in Settings rather than
        turning on requester approval. Changing the approver roster notifies everyone who owns the rail.
      </blockquote>

      <h2>Designated approvers</h2>
      <p>
        You can name a specific approver roster. When you do, only those people are asked — not everyone who
        happens to hold the permission. An approval queue that emails ten people is one that ten people learn to
        ignore.
      </p>

      <h2>After approval</h2>
      <ul>
        <li>
          <strong>Approved and released.</strong> Arc debits the funding bank and submits each payment. Vendors
          are paid on the provider&apos;s normal ACH timing.
        </li>
        <li>
          <strong>Approved and scheduled.</strong> The run holds until its date, then releases automatically.
        </li>
        <li>
          <strong>Rejected.</strong> Nothing moves. The bills return to the queue and the preparer is told why.
        </li>
      </ul>
      <p>
        Every payment sent gets a remittance advice to the vendor so they can apply it. Arc&apos;s own fee is
        debited separately — if that fee debit fails, your vendors were still paid normally and only Arc&apos;s
        balance is outstanding.
      </p>

      <h2>When something goes wrong mid-release</h2>
      <ul>
        <li>
          <strong>Submission needs confirmation.</strong> Arc could not tell whether a payment reached the
          provider. Automatic recovery retries with the same idempotency key so it cannot double-pay. Do not
          build a replacement run until the provider record is checked.
        </li>
        <li>
          <strong>Payout blocked.</strong> Your bank was debited and the vendor payout did not go through. Arc
          holds the funds and retries; check the vendor&apos;s payout account.
        </li>
        <li>
          <strong>Payment returned.</strong> The vendor&apos;s bank rejected the payment. The payable reopens and
          the vendor has not been paid — fix the destination before re-running it.
        </li>
      </ul>
    </>
  )
}
