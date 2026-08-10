import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export interface VendorBillDecisionEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  kind: "approved" | "rejected"
  /** "invoice 1042" or "your invoice" — matches the subject line's phrasing. */
  invoiceLabel: string
  projectName: string | null
  reason?: string | null
  actionHref?: string
}

export function VendorBillDecisionEmail({
  orgName,
  orgLogoUrl,
  kind,
  invoiceLabel,
  projectName,
  reason,
  actionHref,
}: VendorBillDecisionEmailProps) {
  const displayOrgName = orgName ?? "Your customer"
  const approved = kind === "approved"
  const onProject = projectName ? ` on ${projectName}` : ""

  return (
    <Html>
      <Head />
      <Preview>{approved ? `${invoiceLabel} was approved for payment` : `${invoiceLabel} was not accepted`}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Invoice Decision</Text>
          </Section>

          <Section style={content}>
            <Heading style={heading}>{approved ? "Invoice approved" : "Invoice not accepted"}</Heading>

            {approved ? (
              <Text style={paragraph}>
                {displayOrgName} approved {invoiceLabel}
                {onProject} for payment. You will get a separate notice when the payment is sent.
              </Text>
            ) : (
              <>
                <Text style={paragraph}>
                  {displayOrgName} could not accept {invoiceLabel}
                  {onProject}.
                </Text>
                {reason ? (
                  <Section style={reasonCard}>
                    <Text style={reasonLabel}>Reason given</Text>
                    <Text style={reasonText}>{reason}</Text>
                  </Section>
                ) : null}
                <Text style={paragraph}>
                  Correct it and submit again — you do not need to start a new contract or purchase order.
                </Text>
              </>
            )}

            {actionHref ? (
              <>
                <Section style={buttonWrap}>
                  <Button style={button} href={actionHref}>
                    View your invoices
                  </Button>
                </Section>
                <Text style={fallbackText}>
                  If the button does not open,{" "}
                  <Link href={actionHref} style={link}>
                    open secure link
                  </Link>
                </Text>
              </>
            ) : null}
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

const reasonCard: React.CSSProperties = {
  margin: "16px 0",
  padding: "14px 16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#fafafa",
}

const reasonLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const reasonText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "26px",
  marginBottom: "16px",
}

const button: React.CSSProperties = {
  backgroundColor: "#3A70EE",
  color: "#ffffff",
  border: "1px solid #3A70EE",
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 700,
  padding: "12px 24px",
  display: "inline-block",
}

const fallbackText: React.CSSProperties = {
  margin: "0",
  color: "#666666",
  fontSize: "12px",
  lineHeight: "1.65",
  textAlign: "center",
}

const link: React.CSSProperties = {
  color: "#3A70EE",
  textDecoration: "underline",
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

export default VendorBillDecisionEmail
