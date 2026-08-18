export default function ArcPayOverviewArticle() {
  return (
    <>
      <p>
        Arc Pay is how you pay subcontractors and suppliers electronically from inside Arc. An approved payable
        goes on a payment run, the run is approved, and the money moves from your funding bank to the vendor&apos;s
        payout bank. No check run, no re-keying into your bank&apos;s portal, and a complete record of who approved
        what.
      </p>

      <h2>What has to be true before money can move</h2>
      <ol>
        <li>
          <strong>Your organization has a funding bank.</strong> This is the account Arc debits. Adding one is not
          enough on its own — a second person has to approve it, and it sits in a cooling period before it becomes
          usable.
        </li>
        <li>
          <strong>Your payment controls are set.</strong> Per-payment, per-run, daily, in-flight, and return-loss
          limits all have to have values before Arc Pay can be enabled. There is no &ldquo;unlimited&rdquo; default.
        </li>
        <li>
          <strong>The vendor is verified.</strong> The vendor completes business and bank verification with Arc&apos;s
          payment provider. Until that finishes, their bills can still be entered and approved — they just cannot be
          paid electronically.
        </li>
        <li>
          <strong>The payable is approved and released.</strong> Compliance holds, lien-waiver rules, and retainage
          rules all apply before a bill is eligible for a run.
        </li>
      </ol>

      <h2>How a vendor gets set up</h2>
      <p>
        You invite them; they do the rest. From the vendor&apos;s record or from the payable workspace, choose{" "}
        <strong>Invite to Arc Pay</strong>. Arc emails the vendor a setup link.
      </p>
      <ul>
        <li>
          <strong>Invited.</strong> The email is out. Nothing has changed about how you pay them yet.
        </li>
        <li>
          <strong>Setup in progress.</strong> The vendor opened verification with the payment provider. They enter
          their own business details and bank account — you never see, enter, or store them.
        </li>
        <li>
          <strong>Ready for Arc Pay.</strong> Verification passed. Their approved bills can go on the next run. Arc
          notifies the person who sent the invite and everyone who owns the payment rail.
        </li>
      </ul>
      <blockquote>
        A vendor verifies once, not once per builder. If they already set up Arc Pay for another builder, your
        invite is a single confirmation step for them rather than a whole onboarding.
      </blockquote>

      <h2>What your team can and cannot see</h2>
      <p>
        Arc only ever shows the vendor&apos;s bank name and the last four digits of the account. Full account and
        routing numbers live with the payment provider and never enter Arc, never appear in an email, and never
        appear in an export. Anyone asking you to email or confirm a full account number is not Arc.
      </p>

      <h2>Suspending or revoking a vendor</h2>
      <p>
        If something looks wrong, you can suspend or revoke a vendor&apos;s Arc Pay access from their record.
      </p>
      <ul>
        <li><strong>Suspended</strong> blocks new payments and can be lifted by your team.</li>
        <li><strong>Revoked</strong> ends the relationship; re-establishing it means a new invite.</li>
      </ul>
      <p>
        Neither status can be undone by the payment provider. A later verification webhook will not quietly
        reactivate a vendor you deliberately cut off — only someone on your team can restore access.
      </p>

      <h2>When a vendor&apos;s payout bank changes</h2>
      <p>
        This is the single most abused moment in construction payments, so Arc treats it as an incident rather
        than a settings update. When a payout bank changes, payments to that vendor are frozen for a cooling
        period, every builder who pays them is notified, and the vendor&apos;s own administrators are warned
        out-of-band.
      </p>
      <p>
        Confirm the change by calling a number you already had for that vendor. Never a number from the email
        announcing the change.
      </p>

      <h2>Staying informed without drowning</h2>
      <p>
        Arc Pay alerts are grouped in <strong>Settings → Notifications</strong> under <em>Arc Pay vendor
        payments</em> and <em>Banking &amp; payment controls</em>. Each one can be turned off individually. The
        ones worth keeping on for anyone who touches money are: a run needing approval, a payment returned, a
        payout blocked, and a payout bank change.
      </p>
    </>
  )
}
