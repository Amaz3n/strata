import { Button, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  buttonFor,
  buttonWrap,
  fallbackText,
  link,
  palette,
  paragraph,
} from "./theme"

/**
 * Money that came back. Several different mechanisms, one shape — because the
 * recipient's first question is always the same: is this mine to fix, and did
 * the counterparty end up with the money or not?
 *
 * - `vendor_returned`   the vendor's bank rejected or returned an Arc Pay payout
 * - `transfer_blocked`  the builder's bank cleared, the vendor payout did not
 * - `vendor_unrecorded` a vendor payment recorded by hand was reversed
 * - `customer_reversed` a customer payment was reversed inside Arc
 * - `qbo_reversed`      a customer payment was deleted in QuickBooks
 */
export type PaymentReturnKind =
  | "vendor_returned"
  | "transfer_blocked"
  | "vendor_unrecorded"
  | "customer_reversed"
  | "qbo_reversed"

export interface PaymentReturnedEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  kind: PaymentReturnKind
  amountLabel?: string | null
  /** Vendor for an AP return, customer for an AR reversal. */
  counterpartyName?: string | null
  /** "Invoice 1042" — the bill or invoice the money was against. */
  documentLabel?: string | null
  projectName?: string | null
  reason?: string | null
  occurredLabel?: string | null
  actionUrl: string
}

const KIND_KICKER: Record<PaymentReturnKind, string> = {
  vendor_returned: "Payment Returned",
  transfer_blocked: "Payout Blocked",
  vendor_unrecorded: "Payment Reversed",
  customer_reversed: "Payment Reversed",
  qbo_reversed: "Reversed In QuickBooks",
}

function headingFor(kind: PaymentReturnKind, amountLabel?: string | null) {
  const amount = amountLabel ?? "A payment"
  switch (kind) {
    case "vendor_returned":
      return `${amount} came back`
    case "transfer_blocked":
      return `${amount} is stuck at Arc`
    case "vendor_unrecorded":
      return `${amount} is owed again`
    case "customer_reversed":
      return `${amount} was reversed`
    case "qbo_reversed":
      return `${amount} was deleted in QuickBooks`
  }
}

function leadFor(kind: PaymentReturnKind) {
  switch (kind) {
    case "vendor_returned":
      return "The vendor's bank rejected this payout and the funds have been returned. The payable is open again and the vendor has not been paid."
    case "transfer_blocked":
      return "Your bank was debited and the money did not reach the vendor. Arc is holding the funds and will retry, but the payout account has to be checked before it can succeed."
    case "vendor_unrecorded":
      return "A vendor payment recorded in Arc was reversed. The payable is open again for that amount and will show as unpaid until it is settled another way."
    case "customer_reversed":
      return "A customer payment that Arc had recorded as settled was reversed. The invoice balance is open again."
    case "qbo_reversed":
      return "A customer payment was deleted in QuickBooks, so Arc reopened the invoice balance to match. Arc did not initiate this and cannot tell whether the money was actually returned to the customer."
  }
}

function stepsFor(kind: PaymentReturnKind): string[] {
  switch (kind) {
    case "vendor_returned":
      return [
        "Confirm the vendor's payout account with someone you already know there, on a number you already have.",
        "Do not re-run the payment until the account is corrected — a second attempt to the same account returns the same way and can carry a bank fee.",
        "The payable is back in the queue and can go on a later run once the destination is fixed.",
      ]
    case "transfer_blocked":
      return [
        "Check the vendor's payout account status; this almost always means their account cannot currently receive funds.",
        "Do not build a replacement run. The money is already out of your bank and Arc is holding it against this payment.",
        "Arc retries automatically. Reconciliation will show the payment as unsettled until it clears.",
      ]
    case "vendor_unrecorded":
      return [
        "Confirm with your bank whether the original payment actually left; a reversal in Arc does not move money on its own.",
        "Check the payable's balance before it goes on another run, so the vendor is not paid twice.",
        "Reconcile the accounting entry — the ledger has to agree with Arc about what this vendor is owed.",
      ]
    case "customer_reversed":
      return [
        "Check the invoice balance — it has reopened by the reversed amount.",
        "Reconcile the bank feed so the reversal is matched rather than double-counted.",
        "If this was a chargeback, gather the delivery and approval record before the response window closes.",
      ]
    case "qbo_reversed":
      return [
        "Confirm the deletion in QuickBooks was intentional before re-billing the customer.",
        "Check whether money was actually returned; a deleted ledger entry is not proof that it was.",
        "Reconcile the bank feed so Arc and QuickBooks agree on the invoice balance.",
      ]
  }
}

export function PaymentReturnedEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  kind = "vendor_returned",
  amountLabel = null,
  counterpartyName = null,
  documentLabel = null,
  projectName = null,
  reason = null,
  occurredLabel = null,
  actionUrl = "#",
}: PaymentReturnedEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hello,"
  const heading = headingFor(kind, amountLabel)
  const steps = stepsFor(kind)
  const counterpartyRowLabel = kind === "customer_reversed" || kind === "qbo_reversed" ? "Customer" : "Vendor"

  return (
    <EmailLayout
      preview={`${heading} · ${displayOrgName}`}
      subtitle={KIND_KICKER[kind]}
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
      footerNote={<>{displayOrgName} payment operations</>}
      tone="danger"
    >
      <Text style={paragraph}>{greeting}</Text>

      <Section style={sectionCard}>
        <Text style={sectionTitle}>The Payment</Text>
        <table style={factTable} cellPadding={0} cellSpacing={0} role="presentation">
          <tbody>
            <tr>
              <td style={factLabelCell}>Amount</td>
              <td style={factValueCellStrong} align="right">
                {amountLabel ?? "—"}
              </td>
            </tr>
            <tr>
              <td style={factLabelCell}>{counterpartyRowLabel}</td>
              <td style={factValueCell} align="right">
                {counterpartyName ?? "—"}
              </td>
            </tr>
            <tr>
              <td style={factLabelCell}>Document</td>
              <td style={factValueCell} align="right">
                {documentLabel ?? "—"}
              </td>
            </tr>
            {projectName ? (
              <tr>
                <td style={factLabelCell}>Project</td>
                <td style={factValueCell} align="right">
                  {projectName}
                </td>
              </tr>
            ) : null}
            <tr>
              <td style={factLabelCellLast}>Reported</td>
              <td style={factValueCellLast} align="right">
                {occurredLabel ?? "Just now"}
              </td>
            </tr>
          </tbody>
        </table>
      </Section>

      {reason ? (
        <Section style={reasonCard}>
          <Text style={reasonLabel}>Reason given</Text>
          <Text style={reasonText}>{reason}</Text>
        </Section>
      ) : null}

      <Section style={stepsCard}>
        <Text style={stepsTitle}>Do this next</Text>
        {steps.map((step, index) => (
          <Text key={`step-${index}`} style={stepText}>
            {index + 1}. {step}
          </Text>
        ))}
      </Section>

      <Section style={buttonWrap}>
        <Button style={buttonFor("danger")} href={actionUrl}>
          Open in Arc
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={actionUrl} style={link}>
          open it directly
        </Link>
        . Never send or confirm bank details by replying to an email about a returned payment.
      </Text>
    </EmailLayout>
  )
}

const sectionCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #e3e3e3",
  backgroundColor: "#ffffff",
}

const sectionTitle: React.CSSProperties = {
  margin: "0",
  padding: "12px 14px",
  borderBottom: "1px solid #f6dcd9",
  backgroundColor: "#fef3f2",
  color: palette.danger,
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const factTable: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
}

const factLabelCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  color: "#475467",
  fontSize: "13px",
  verticalAlign: "middle",
}

const factLabelCellLast: React.CSSProperties = {
  ...factLabelCell,
  borderBottom: "none",
}

const factValueCell: React.CSSProperties = {
  padding: "10px 14px",
  borderBottom: "1px solid #eaecf0",
  color: "#101828",
  fontSize: "13px",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
  verticalAlign: "middle",
}

const factValueCellLast: React.CSSProperties = {
  ...factValueCell,
  borderBottom: "none",
}

const factValueCellStrong: React.CSSProperties = {
  ...factValueCell,
  color: palette.danger,
  fontSize: "18px",
  fontWeight: 700,
  letterSpacing: "-0.3px",
}

const reasonCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "12px 14px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#fafafa",
}

const reasonLabel: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const reasonText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "13px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

const stepsCard: React.CSSProperties = {
  marginTop: "16px",
  border: "1px solid #fedf89",
  backgroundColor: "#fffaeb",
  padding: "12px 14px",
}

const stepsTitle: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: palette.warning,
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const stepText: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#7a4708",
  fontSize: "12px",
  lineHeight: "1.55",
}

export default PaymentReturnedEmail
