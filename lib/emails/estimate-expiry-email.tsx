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

export interface EstimateExpiryEmailProps {
  recipientName: string | null
  estimateTitle: string
  prospectName?: string | null
  recipientContactName?: string | null
  expiresLabel: string
  /** True once the estimate is already past its valid-until date. */
  expired: boolean
  totalLabel?: string | null
  pipelineLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
}

export function EstimateExpiryEmail({
  recipientName,
  estimateTitle = "Estimate",
  prospectName,
  recipientContactName,
  expiresLabel = "",
  expired = false,
  totalLabel,
  pipelineLink = "#",
  orgName,
  orgLogoUrl,
}: EstimateExpiryEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"
  const eventLabel = expired ? "Estimate Expired Unsigned" : "Estimate Expiring Soon"

  return (
    <Html>
      <Head />
      <Preview>
        {eventLabel}: {estimateTitle}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>{eventLabel}</Text>
          </Section>

          <Section style={content}>
            <Text style={eventLabelText}>{eventLabel}</Text>
            <Heading style={heading}>{estimateTitle}</Heading>
            <Text style={subjectText}>{expired ? `Expired ${expiresLabel}` : `Expires ${expiresLabel}`}</Text>

            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>
              {expired ? (
                <>
                  The estimate <strong>{estimateTitle}</strong> passed its validity date without a client
                  signature. Follow up with the client, or revise and re-send with a new date.
                </>
              ) : (
                <>
                  The estimate <strong>{estimateTitle}</strong> is still out for review and its validity date is
                  approaching. A nudge to the client now can keep the decision moving.
                </>
              )}
            </Text>

            <Section style={metaCard}>
              {prospectName ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Prospect:</span> <span style={metaValue}>{prospectName}</span>
                </Text>
              ) : null}
              {recipientContactName ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Client:</span> <span style={metaValue}>{recipientContactName}</span>
                </Text>
              ) : null}
              {totalLabel ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Value:</span> <span style={metaValue}>{totalLabel}</span>
                </Text>
              ) : null}
              <Text style={metaRow}>
                <span style={metaLabel}>{expired ? "Expired:" : "Expires:"}</span>{" "}
                <span style={metaValue}>{expiresLabel}</span>
              </Text>
            </Section>

            <Section style={buttonWrap}>
              <Button style={button} href={pipelineLink}>
                Open in Arc
              </Button>
            </Section>

            <Text style={fallbackText}>
              If the button does not open,{" "}
              <Link href={pipelineLink} style={link}>
                open the pipeline
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
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif',
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

const metaLabel: React.CSSProperties = {
  color: "#6a6a6a",
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
}

const metaValue: React.CSSProperties = {
  color: "#1f1f1f",
}

const buttonWrap: React.CSSProperties = {
  marginTop: "24px",
  textAlign: "center",
}

const button: React.CSSProperties = {
  backgroundColor: "#111111",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: 600,
  padding: "12px 22px",
  textDecoration: "none",
}

const fallbackText: React.CSSProperties = {
  margin: "14px 0 0 0",
  textAlign: "center",
  color: "#6f6f6f",
  fontSize: "12px",
}

const link: React.CSSProperties = {
  color: "#111111",
  textDecoration: "underline",
}

const hr: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #ebebeb",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "18px 40px",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#8a8a8a",
  fontSize: "12px",
  textAlign: "center",
}
