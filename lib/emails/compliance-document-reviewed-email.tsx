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

export interface ComplianceDocumentReviewedEmailProps {
  orgName?: string | null
  companyName: string
  documentType: string
  decision: "approved" | "rejected"
  reviewNotes?: string | null
  rejectionReason?: string | null
}

export function ComplianceDocumentReviewedEmail({
  orgName,
  companyName,
  documentType,
  decision,
  reviewNotes,
  rejectionReason,
}: ComplianceDocumentReviewedEmailProps) {
  const isApproved = decision === "approved"
  const previewText = `Your ${documentType} has been ${isApproved ? "approved" : "rejected"}`

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
            <Heading style={heading}>
              Compliance Document {isApproved ? "Approved" : "Rejected"}
            </Heading>
            <Text style={paragraph}>
              Your <strong>{documentType}</strong> document for <strong>{companyName}</strong> has been reviewed.
            </Text>
            <Section style={isApproved ? statusBoxApproved : statusBoxRejected}>
              <Text style={statusText}>
                {isApproved ? "Approved" : "Rejected"}
              </Text>
            </Section>
            {!isApproved && rejectionReason && (
              <Section style={reasonBox}>
                <Text style={reasonLabel}>Reason for Rejection</Text>
                <Text style={reasonText}>{rejectionReason}</Text>
              </Section>
            )}
            {reviewNotes && (
              <Section style={notesBox}>
                <Text style={reasonLabel}>Reviewer Notes</Text>
                <Text style={reasonText}>{reviewNotes}</Text>
              </Section>
            )}
            {!isApproved && (
              <Text style={paragraph}>
                Please upload a new document that addresses the concerns mentioned above.
              </Text>
            )}
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

const statusBoxApproved: React.CSSProperties = {
  backgroundColor: "#ecfdf5",
  borderRadius: "8px",
  padding: "16px",
  marginBottom: "24px",
  textAlign: "center",
  border: "1px solid #a7f3d0",
}

const statusBoxRejected: React.CSSProperties = {
  backgroundColor: "#fef2f2",
  borderRadius: "8px",
  padding: "16px",
  marginBottom: "24px",
  textAlign: "center",
  border: "1px solid #fecaca",
}

const statusText: React.CSSProperties = {
  fontSize: "18px",
  fontWeight: "600",
  margin: "0",
}

const reasonBox: React.CSSProperties = {
  backgroundColor: "#fef2f2",
  borderRadius: "8px",
  padding: "16px",
  marginBottom: "24px",
  border: "1px solid #fecaca",
}

const notesBox: React.CSSProperties = {
  backgroundColor: "#f9fafb",
  borderRadius: "8px",
  padding: "16px",
  marginBottom: "24px",
}

const reasonLabel: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "12px",
  fontWeight: "500",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  margin: "0 0 8px 0",
}

const reasonText: React.CSSProperties = {
  color: "#111827",
  fontSize: "14px",
  lineHeight: "1.5",
  margin: "0",
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

export default ComplianceDocumentReviewedEmail
