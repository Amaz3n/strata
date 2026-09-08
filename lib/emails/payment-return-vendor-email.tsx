import { Heading, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import { heading, paragraph } from "./theme"

/**
 * The other half of remittance advice: the money came back.
 *
 * A vendor who got "Payment sent — it should appear within a few business days"
 * and then saw nothing, or saw a deposit reverse out days later, had no way to
 * tell an ACH return from a slow bank. They chased the PM, the PM chased AP, and
 * AP had known for two days. The builder is told by
 * `payment-returned-email.tsx`; this is the vendor's copy of the same fact.
 *
 * Deliberately says nothing about *why*. The return code is between the builder
 * and their bank — quoting "insufficient funds" to a subcontractor is a
 * commercial statement Arc has no business making on the builder's behalf — and
 * there is no action the vendor can take on it either way. What they need is
 * that the invoice is open again and roughly when to expect the retry.
 */
export interface PaymentReturnVendorEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  billNumber: string | null
  projectName: string | null
  amountCents: number
  /**
   * `post_payout` — the deposit landed and was pulled back out.
   * `post_transfer` — Arc had released it but it had not landed yet.
   */
  stage: "post_payout" | "post_transfer"
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

export function PaymentReturnVendorEmail({
  orgName,
  orgLogoUrl,
  billNumber,
  projectName,
  amountCents,
  stage,
}: PaymentReturnVendorEmailProps) {
  const displayOrgName = orgName ?? "Your customer"
  const invoiceLabel = billNumber ? `invoice ${billNumber}` : "an invoice"

  const lead =
    stage === "post_payout"
      ? `A payment of ${money(amountCents)} to you for ${invoiceLabel} was returned by ${displayOrgName}'s bank. If it had already reached your account, your bank will have taken it back out.`
      : `A payment of ${money(amountCents)} to you for ${invoiceLabel} was stopped before it reached your bank. ${displayOrgName}'s bank returned the funds, so the deposit will not arrive.`

  const rows: Array<{ label: string; value: string }> = [
    { label: "Invoice", value: billNumber ?? "—" },
    { label: "Project", value: projectName ?? "—" },
    { label: "Amount", value: money(amountCents) },
  ]

  return (
    <EmailLayout
      preview={`A payment to you was returned: ${money(amountCents)}`}
      subtitle="Payment Returned"
      tone="warning"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Heading style={heading}>A payment to you was returned</Heading>
      <Text style={paragraph}>{lead}</Text>
      <Text style={paragraph}>
        Your invoice is open again for this amount and {displayOrgName} still owes it. There is nothing for you to do —
        they have been told, and they will pay it again once their bank is sorted out. If you need a date, ask the
        person you normally invoice.
      </Text>

      <Section style={detailCard}>
        {rows.map((row) => (
          <table key={row.label} width="100%" cellPadding="0" cellSpacing="0" role="presentation">
            <tbody>
              <tr>
                <td style={detailLabelCell}>{row.label}</td>
                <td style={detailValueCell}>{row.value}</td>
              </tr>
            </tbody>
          </table>
        ))}
      </Section>
    </EmailLayout>
  )
}

const detailCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "14px 16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#fafafa",
}

const detailLabelCell: React.CSSProperties = {
  padding: "4px 16px 4px 0",
  color: "#666666",
  fontSize: "13px",
  lineHeight: "1.5",
}

const detailValueCell: React.CSSProperties = {
  padding: "4px 0",
  textAlign: "right",
  color: "#111111",
  fontSize: "13px",
  lineHeight: "1.5",
  fontFamily: "monospace",
}

export default PaymentReturnVendorEmail
