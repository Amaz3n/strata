import { Heading, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  heading,
  paragraph,
} from "./theme"

export interface RemittanceAdviceEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  billNumber: string | null
  projectName: string | null
  invoiceTotalCents: number
  retainageHeldCents: number
  amountPaidCents: number
  /** Human label for how the money was sent — "Direct deposit", "Check", … */
  methodLabel: string
  /** The raw method key. A check travels by post, so it gets different arrival copy. */
  method: string
  reference: string | null
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

export function RemittanceAdviceEmail({
  orgName,
  orgLogoUrl,
  billNumber,
  projectName,
  invoiceTotalCents,
  retainageHeldCents,
  amountPaidCents,
  methodLabel,
  method,
  reference,
}: RemittanceAdviceEmailProps) {
  const displayOrgName = orgName ?? "Your customer"

  // An ACH lands in an account and a check has to arrive in the post; promising
  // "a few business days" for a posted check would be the builder's problem the
  // moment it was not true.
  const arrivalCopy =
    method === "check"
      ? "has sent you a check. Allow normal mail time for it to arrive."
      : "has sent a payment to your bank account. It should appear within a few business days."

  const rows: Array<{ label: string; value: string }> = [
    { label: "Invoice", value: billNumber ?? "—" },
    { label: "Project", value: projectName ?? "—" },
    { label: "Invoice total", value: money(invoiceTotalCents) },
  ]
  // Retainage held is named explicitly. A sub who was expecting the full invoice
  // and receives less will otherwise assume a short payment and call about it.
  if (retainageHeldCents > 0) rows.push({ label: "Retainage held", value: `− ${money(retainageHeldCents)}` })
  rows.push({ label: "Amount paid", value: money(amountPaidCents) })
  rows.push({ label: "Sent by", value: methodLabel })
  if (reference) rows.push({ label: "Reference", value: reference })

  return (
    <EmailLayout
      preview={`Payment sent: ${money(amountPaidCents)}${billNumber ? ` for invoice ${billNumber}` : ""}`}
      subtitle="Remittance Advice"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Heading style={heading}>Payment sent</Heading>
      <Text style={paragraph}>
        {displayOrgName} {arrivalCopy}
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

export default RemittanceAdviceEmail
