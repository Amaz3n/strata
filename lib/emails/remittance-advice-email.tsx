import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components"

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
    <Html>
      <Head />
      <Preview>{`Payment sent: ${money(amountPaidCents)}${billNumber ? ` for invoice ${billNumber}` : ""}`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Remittance Advice</Text>
          </Section>

          <Section style={content}>
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
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>Sent via Arc</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#ececea",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif',
  margin: "0",
  padding: "32px 0",
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "620px",
  border: "1px solid #dcdcdc",
}

const header: React.CSSProperties = {
  textAlign: "center",
  padding: "36px 40px 22px 40px",
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
  margin: "0",
  width: "56px",
  height: "56px",
  display: "block",
  marginLeft: "auto",
  marginRight: "auto",
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
  color: "#6b6b6b",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const content: React.CSSProperties = {
  padding: "30px 40px 32px 40px",
}

const heading: React.CSSProperties = {
  margin: "0 0 16px 0",
  color: "#111111",
  fontSize: "28px",
  lineHeight: "1.2",
  fontWeight: 700,
  letterSpacing: "-0.5px",
}

const paragraph: React.CSSProperties = {
  margin: "0 0 12px 0",
  color: "#2f2f2f",
  fontSize: "14px",
  lineHeight: "1.6",
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

const hr: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #ebebeb",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "18px 40px 22px 40px",
  backgroundColor: "#ffffff",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#777777",
  fontSize: "12px",
  lineHeight: "1.5",
  textAlign: "center",
}

export default RemittanceAdviceEmail
