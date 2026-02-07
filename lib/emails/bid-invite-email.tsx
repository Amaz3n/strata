import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export interface BidInviteEmailProps {
  companyName?: string | null
  contactName?: string | null
  projectName?: string | null
  bidPackageTitle: string
  trade?: string | null
  dueDate?: string | null
  orgName?: string | null
  bidLink: string
}

export function BidInviteEmail({
  companyName,
  contactName,
  projectName,
  bidPackageTitle,
  trade,
  dueDate,
  orgName,
  bidLink,
}: BidInviteEmailProps) {
  const previewText = `You're invited to bid on ${bidPackageTitle}`
  const displayOrgName = orgName ?? "Arc"
  const greeting = contactName ? `Hello ${contactName},` : "Hello,"

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={logoSection}>
            <Text style={logo}>Arc</Text>
          </Section>
          <Heading style={heading}>Invitation to Bid</Heading>
          <Text style={paragraph}>{greeting}</Text>
          <Text style={paragraph}>
            <strong>{displayOrgName}</strong> has invited{" "}
            {companyName ? <strong>{companyName}</strong> : "you"} to submit a bid for the
            following package:
          </Text>
          <Section style={detailsSection}>
            <Text style={detailLabel}>Bid Package</Text>
            <Text style={detailValue}>{bidPackageTitle}</Text>
            {trade && (
              <>
                <Text style={detailLabel}>Trade</Text>
                <Text style={detailValue}>{trade}</Text>
              </>
            )}
            {projectName && (
              <>
                <Text style={detailLabel}>Project</Text>
                <Text style={detailValue}>{projectName}</Text>
              </>
            )}
            {dueDate && (
              <>
                <Text style={detailLabel}>Due Date</Text>
                <Text style={detailValue}>{dueDate}</Text>
              </>
            )}
          </Section>
          <Section style={buttonContainer}>
            <Button style={button} href={bidLink}>
              View Bid Package
            </Button>
          </Section>
          <Text style={fallbackText}>
            or copy and paste this URL into your browser:{" "}
            <Link href={bidLink} style={link}>
              {bidLink}
            </Link>
          </Text>
          <Hr style={hr} />
          <Text style={footer}>
            This invitation was sent to{" "}
            <span style={footerHighlight}>{companyName ?? "your company"}</span>. If you were not
            expecting this invitation, you can ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#ffffff",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  border: "1px solid #eaeaea",
  borderRadius: "5px",
  margin: "40px auto",
  padding: "20px",
  maxWidth: "465px",
}

const logoSection: React.CSSProperties = {
  marginTop: "32px",
  textAlign: "center",
}

const logo: React.CSSProperties = {
  color: "#000000",
  fontSize: "24px",
  fontWeight: "700",
  margin: "0",
  letterSpacing: "-0.5px",
}

const heading: React.CSSProperties = {
  color: "#000000",
  fontSize: "24px",
  fontWeight: "400",
  textAlign: "center",
  margin: "30px 0",
  padding: "0",
}

const paragraph: React.CSSProperties = {
  color: "#000000",
  fontSize: "14px",
  lineHeight: "24px",
  margin: "0 0 10px 0",
}

const detailsSection: React.CSSProperties = {
  backgroundColor: "#f9fafb",
  borderRadius: "5px",
  padding: "16px",
  margin: "20px 0",
}

const detailLabel: React.CSSProperties = {
  color: "#666666",
  fontSize: "12px",
  fontWeight: "600",
  textTransform: "uppercase",
  margin: "0 0 4px 0",
  letterSpacing: "0.5px",
}

const detailValue: React.CSSProperties = {
  color: "#000000",
  fontSize: "14px",
  fontWeight: "500",
  margin: "0 0 12px 0",
}

const buttonContainer: React.CSSProperties = {
  textAlign: "center",
  marginTop: "32px",
  marginBottom: "32px",
}

const button: React.CSSProperties = {
  backgroundColor: "#000000",
  borderRadius: "5px",
  color: "#ffffff",
  fontSize: "12px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center",
  padding: "12px 20px",
  display: "inline-block",
}

const link: React.CSSProperties = {
  color: "#2563eb",
  textDecoration: "none",
}

const fallbackText: React.CSSProperties = {
  color: "#000000",
  fontSize: "14px",
  lineHeight: "24px",
  margin: "0",
}

const hr: React.CSSProperties = {
  border: "none",
  borderTop: "1px solid #eaeaea",
  margin: "26px 0",
  width: "100%",
}

const footer: React.CSSProperties = {
  color: "#666666",
  fontSize: "12px",
  lineHeight: "24px",
  margin: "0",
}

const footerHighlight: React.CSSProperties = {
  color: "#000000",
}

export default BidInviteEmail
