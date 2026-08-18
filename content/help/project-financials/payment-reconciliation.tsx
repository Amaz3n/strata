export default function PaymentReconciliationArticle() {
  return (
    <>
      <p>
        Every day Arc compares what it believes about your vendor payments against what the payment provider
        reports. Anything the two cannot agree on becomes an exception. The reconciliation queue lives at{" "}
        <strong>Payables → Reconciliation</strong>, and a summary is emailed when the daily pass finishes —
        including when it finishes with exceptions.
      </p>

      <h2>What the pass actually checks</h2>
      <ul>
        <li>Every debit Arc initiated cleared the funding bank for the amount Arc recorded.</li>
        <li>Every vendor payout the provider reports has a matching disbursement in Arc.</li>
        <li>Nothing has been sitting in an intermediate state longer than it should.</li>
        <li>Fees charged match the fees Arc quoted.</li>
      </ul>
      <p>
        A pass that finds nothing still tells you something: it means the day&apos;s money movement is fully
        accounted for. That is worth reading.
      </p>

      <h2>The exceptions you will actually see</h2>

      <h3>Payment stuck in an intermediate state</h3>
      <p>
        A disbursement or run has not moved in longer than a healthy system would leave it. This is the worst
        state on the rail because money may already be out of your bank. Open the payment, check the provider
        record, and do not build a replacement — the original may still settle.
      </p>

      <h3>Submission could not be confirmed</h3>
      <p>
        Arc called the provider and did not get a trustworthy answer, so it cannot say whether the debit
        happened. Recovery retries with the same idempotency key, which means it physically cannot double-pay.
        Confirm against the provider record before anyone builds a replacement run.
      </p>

      <h3>Vendor payout blocked after the debit cleared</h3>
      <p>
        Your bank was debited and the vendor was not paid. Arc holds the funds. This almost always means the
        vendor&apos;s payout account cannot currently receive money. Contact the vendor; do not re-run the
        payment.
      </p>

      <h3>Returned payment</h3>
      <p>
        The vendor&apos;s bank sent the money back. The payable reopens automatically. Correct the destination
        before it goes on another run — a second attempt to the same account returns the same way, often with a
        bank fee attached.
      </p>

      <h3>Amount or fee mismatch</h3>
      <p>
        The provider reports a different figure than Arc recorded. Explain it if there is a known reason (a fee
        adjustment, a partial return), or escalate it. Do not close it just to clear the queue.
      </p>

      <h3>Return-loss ceiling reached</h3>
      <p>
        Your organization sets a limit on how much returned volume it will tolerate before the rail pauses
        itself. Hitting it is a signal that vendor bank data has gone stale somewhere, not just that one payment
        failed.
      </p>

      <h2>Working the queue</h2>
      <ol>
        <li>
          <strong>Take the money-is-moving-wrong items first.</strong> Stuck payments and unconfirmed submissions
          outrank amount mismatches, because they can still get worse.
        </li>
        <li>
          <strong>Explain rather than close.</strong> An explained exception stays out of tomorrow&apos;s email
          unless the amount changes. A closed one with no reason teaches the next person nothing.
        </li>
        <li>
          <strong>Reconcile the accounting side too.</strong> A payment that settled correctly at the provider
          but never reached your ledger shows up in the nightly accounting reconciliation instead, on{" "}
          <strong>Books → Period close</strong>.
        </li>
      </ol>

      <h2>If reconciliation stops running</h2>
      <p>
        A reconciliation that silently stopped is more dangerous than one that reports problems, so Arc monitors
        for it and raises a payment operations alert when the daily pass has not run. If you get that alert, do
        not assume the quiet days in between were clean.
      </p>

      <h2>Who gets told</h2>
      <p>
        Reconciliation results go to everyone with the reconcile permission; stuck-rail alerts also go to the
        people who own the payment rail. Both are tunable in <strong>Settings → Notifications</strong>, under{" "}
        <em>Accounting &amp; reconciliation</em> and <em>Arc Pay vendor payments</em>.
      </p>
    </>
  )
}
