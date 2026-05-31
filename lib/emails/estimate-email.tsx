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

export interface EstimateEmailProps {
  estimateTitle: string
  reviewLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  projectName?: string | null
  totalLabel?: string | null
  validUntil?: string | null
  message?: string | null
  previewText?: string
}

export function EstimateEmail({
  estimateTitle = "Estimate",
  reviewLink = "#",
  orgName,
  orgLogoUrl,
  recipientName,
  projectName,
  totalLabel,
  validUntil,
  message,
  previewText,
}: EstimateEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName?.trim() ? `Hi ${recipientName.trim()},` : "Hello,"
  const resolvedPreview = previewText ?? `${displayOrgName} sent you an estimate: ${estimateTitle}`

  return (
    <Html>
      <Head />
      <Preview>{resolvedPreview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Estimate for review</Text>
          </Section>

          <Section style={content}>
            <Text style={eventLabelText}>Estimate</Text>
            <Heading style={heading}>Your estimate is ready</Heading>
            <Text style={subjectText}>{estimateTitle}</Text>

            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>
              {message?.trim() ? (
                message
              ) : (
                <>
                  <strong>{displayOrgName}</strong> has prepared an estimate for you. Review the full
                  breakdown online, then approve it, reject it, or request changes — right from the page.
                </>
              )}
            </Text>

            <Section style={metaCard}>
              <Text style={metaRow}>
                <span style={metaLabel}>Estimate:</span> <span style={metaValue}>{estimateTitle}</span>
              </Text>
              {projectName ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
                </Text>
              ) : null}
              {totalLabel ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Total:</span> <span style={metaValue}>{totalLabel}</span>
                </Text>
              ) : null}
              <Text style={metaRowLast}>
                <span style={metaLabel}>{validUntil ? "Valid until:" : "From:"}</span>{" "}
                <span style={metaValue}>{validUntil ?? displayOrgName}</span>
              </Text>
            </Section>

            <Section style={buttonWrap}>
              <Button style={button} href={reviewLink}>
                Review estimate
              </Button>
            </Section>

            <Text style={fallbackText}>
              If the button does not open,{" "}
              <Link href={reviewLink} style={link}>
                open secure link
              </Link>
            </Text>
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

const eventLabelText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#666666",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const heading: React.CSSProperties = {
  margin: "0",
  color: "#111111",
  fontSize: "34px",
  lineHeight: "1.1",
  fontWeight: 700,
  letterSpacing: "-0.9px",
}

const subjectText: React.CSSProperties = {
  margin: "12px 0 24px 0",
  color: "#111111",
  fontSize: "18px",
  fontWeight: 600,
  lineHeight: "1.5",
}

const paragraph: React.CSSProperties = {
  margin: "0 0 12px 0",
  color: "#2f2f2f",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

const metaCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "14px 16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#fafafa",
}

const metaRow: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#424242",
  fontSize: "13px",
  lineHeight: "1.5",
}

const metaRowLast: React.CSSProperties = {
  ...metaRow,
  margin: "0",
}

const metaLabel: React.CSSProperties = {
  color: "#6a6a6a",
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
}

const metaValue: React.CSSProperties = {
  color: "#111111",
  fontSize: "13px",
  fontWeight: 600,
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

export default EstimateEmail
