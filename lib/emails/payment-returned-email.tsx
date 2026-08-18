import { Body, Button, Container, Head, Heading, Hr, Html, Img, Link, Preview, Section, Text } from "@react-email/components"

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
    <Html>
      <Head />
      <Preview>{`${heading} · ${displayOrgName}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>{KIND_KICKER[kind]}</Text>
          </Section>

          <Section style={hero}>
            <Text style={heroKicker}>{KIND_KICKER[kind]}</Text>
            <Heading style={heroHeading}>{heading}</Heading>
            <Text style={heroMeta}>{leadFor(kind)}</Text>
          </Section>

          <Section style={content}>
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
              <Button style={button} href={actionUrl}>
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
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>Sent via Arc · {displayOrgName} payment operations</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#f4eceb",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif',
  margin: "0",
  padding: "24px 0",
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "680px",
  border: "1px solid #dcdcdc",
}

const header: React.CSSProperties = {
  textAlign: "center",
  padding: "34px 40px 20px 40px",
  borderBottom: "1px solid #ebebeb",
}

const logoImage: React.CSSProperties = {
  border: "1px solid #d6d6d6",
  backgroundColor: "#ffffff",
  display: "block",
  margin: "0 auto",
  padding: "6px",
  width: "56px",
  height: "56px",
  objectFit: "contain",
}

const logoFallback: React.CSSProperties = {
  margin: "0 auto",
  width: "56px",
  height: "56px",
  display: "block",
  textAlign: "center",
  lineHeight: "56px",
  border: "1px solid #d6d6d6",
  backgroundColor: "#fff",
  color: "#111111",
  fontWeight: 700,
  fontSize: "18px",
}

const brandName: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#111111",
  fontSize: "15px",
  fontWeight: 700,
}

const brandSub: React.CSSProperties = {
  margin: "4px 0 0 0",
  color: "#b42318",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const hero: React.CSSProperties = {
  backgroundColor: "#912018",
  color: "#fef6f5",
  padding: "26px 32px",
  borderBottom: "1px solid #f3c9c4",
}

const heroKicker: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#fbd5d0",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const heroHeading: React.CSSProperties = {
  margin: "0",
  color: "#fff6f5",
  fontSize: "30px",
  lineHeight: "1.1",
  fontWeight: 700,
  letterSpacing: "-0.8px",
}

const heroMeta: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#f7d9d5",
  fontSize: "13px",
  lineHeight: "1.55",
}

const content: React.CSSProperties = {
  padding: "24px 32px 30px 32px",
}

const paragraph: React.CSSProperties = {
  margin: "0 0 12px 0",
  color: "#2f2f2f",
  fontSize: "14px",
  lineHeight: "1.6",
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
  color: "#b42318",
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
  color: "#b42318",
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
  color: "#b54708",
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

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "22px",
}

const button: React.CSSProperties = {
  backgroundColor: "#b42318",
  color: "#ffffff",
  borderRadius: "0",
  padding: "13px 26px",
  fontSize: "13px",
  fontWeight: 700,
  textDecoration: "none",
  textTransform: "uppercase",
  letterSpacing: "0.6px",
}

const fallbackText: React.CSSProperties = {
  margin: "14px 0 0 0",
  color: "#676767",
  fontSize: "12px",
  lineHeight: "1.5",
  textAlign: "center",
}

const link: React.CSSProperties = {
  color: "#b42318",
  textDecoration: "underline",
}

const hr: React.CSSProperties = {
  borderColor: "#e6e6e6",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "16px 32px 20px 32px",
  textAlign: "center",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#7c7c7c",
  fontSize: "12px",
  textAlign: "center",
}

export default PaymentReturnedEmail
