import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export interface ComplianceDocumentUploadedEmailProps {
  orgName?: string | null
  companyName: string
  documentType: string
  uploadedAt?: string
}

export function ComplianceDocumentUploadedEmail({
  orgName,
  companyName,
  documentType,
  uploadedAt,
}: ComplianceDocumentUploadedEmailProps) {
  const previewText = `New compliance document uploaded by ${companyName}`

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Text style={logoText}>{orgName || "Arc"}</Text>
          </Section>
          <Section style={content}>
            <Heading style={heading}>Compliance Document Uploaded</Heading>
            <Text style={paragraph}>
              <strong>{companyName}</strong> has uploaded a new compliance document that requires your review.
            </Text>
            <Section style={detailsBox}>
              <Text style={detailLabel}>Document Type</Text>
              <Text style={detailValue}>{documentType}</Text>
              {uploadedAt && (
                <>
                  <Text style={detailLabel}>Uploaded</Text>
                  <Text style={detailValue}>{uploadedAt}</Text>
                </>
              )}
            </Section>
            <Text style={paragraph}>
              Please log in to your Arc account to review and approve or reject this document.
            </Text>
          </Section>
          <Section style={footer}>
            <Text style={footerText}>
              This is an automated notification from Arc.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "600px",
}

const header: React.CSSProperties = {
  backgroundColor: "#111827",
  padding: "24px 40px",
}

const logoText: React.CSSProperties = {
  color: "#ffffff",
  fontSize: "24px",
  fontWeight: "700",
  margin: "0",
  letterSpacing: "-0.5px",
}

const content: React.CSSProperties = {
  padding: "40px",
}

const heading: React.CSSProperties = {
  color: "#111827",
  fontSize: "24px",
  fontWeight: "700",
  lineHeight: "1.3",
  margin: "0 0 16px 0",
}

const paragraph: React.CSSProperties = {
  color: "#4b5563",
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 24px 0",
}

const detailsBox: React.CSSProperties = {
  backgroundColor: "#f9fafb",
  borderRadius: "8px",
  padding: "20px",
  marginBottom: "24px",
}

const detailLabel: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "12px",
  fontWeight: "500",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  margin: "0 0 4px 0",
}

const detailValue: React.CSSProperties = {
  color: "#111827",
  fontSize: "16px",
  fontWeight: "600",
  margin: "0 0 16px 0",
}

const footer: React.CSSProperties = {
  backgroundColor: "#f9fafb",
  padding: "24px 40px",
  borderTop: "1px solid #e5e7eb",
}

const footerText: React.CSSProperties = {
  color: "#9ca3af",
  fontSize: "13px",
  lineHeight: "1.5",
  margin: "0",
  textAlign: "center",
}

export default ComplianceDocumentUploadedEmail
