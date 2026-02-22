import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Hr,
  Section,
  Text,
} from "@react-email/components"

export interface ComplianceDocumentReviewedEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  companyName: string
  documentType: string
  decision: "approved" | "rejected"
  reviewNotes?: string | null
  rejectionReason?: string | null
}

export function ComplianceDocumentReviewedEmail({
  orgName,
  orgLogoUrl,
  companyName,
  documentType,
  decision,
  reviewNotes,
  rejectionReason,
}: ComplianceDocumentReviewedEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const isApproved = decision === "approved"
  const previewText = `Your ${documentType} has been ${isApproved ? "approved" : "rejected"}`

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>Compliance</Text>
          </Section>

          <Section style={content}>
            <Text style={eventLabelText}>Document Reviewed</Text>
            <Heading style={heading}>{isApproved ? "Document Approved" : "Document Rejected"}</Heading>
            <Text style={subjectText}>{documentType}</Text>

            <Text style={paragraph}>
              Your <strong>{documentType}</strong> document for <strong>{companyName}</strong> has been reviewed.
            </Text>

            <Section style={metaCard}>
              <Text style={metaRow}>
                <span style={metaLabel}>Company:</span> <span style={metaValue}>{companyName}</span>
              </Text>
              <Text style={metaRow}>
                <span style={metaLabel}>Document Type:</span> <span style={metaValue}>{documentType}</span>
              </Text>
              <Text style={metaRow}>
                <span style={metaLabel}>Decision:</span>{" "}
                <span style={metaValue}>{isApproved ? "Approved" : "Rejected"}</span>
              </Text>
            </Section>

            <Section style={isApproved ? approvedCard : rejectedCard}>
              <Text style={isApproved ? approvedLabel : rejectedLabel}>
                {isApproved ? "Approved" : "Action Required"}
              </Text>
              <Text style={isApproved ? approvedStatusText : rejectedStatusText}>
                {isApproved ? "Document approved" : "Document rejected"}
              </Text>
              <Text style={isApproved ? approvedContentText : rejectedContentText}>
                {isApproved
                  ? "No additional action is required at this time."
                  : "Please review the notes below and submit an updated document."}
              </Text>
            </Section>

            {!isApproved && rejectionReason && (
              <Section style={reasonBox}>
                <Text style={detailLabel}>Reason for Rejection</Text>
                <Text style={detailText}>{rejectionReason}</Text>
              </Section>
            )}
            {reviewNotes && (
              <Section style={notesBox}>
                <Text style={detailLabel}>Reviewer Notes</Text>
                <Text style={detailText}>{reviewNotes}</Text>
              </Section>
            )}
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
  color: "#111111",
  fontSize: "13px",
  fontWeight: 600,
}

const approvedCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "2px solid #1fca84",
  backgroundColor: "#0f3a2e",
}

const rejectedCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "2px solid #d08a8a",
  backgroundColor: "#f3dcdc",
}

const approvedLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#cfe2d5",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const rejectedLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#8f4a4a",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const approvedStatusText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#22e38a",
  fontWeight: 700,
  fontSize: "16px",
}

const rejectedStatusText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#b42323",
  fontWeight: 700,
  fontSize: "16px",
}

const approvedContentText: React.CSSProperties = {
  margin: "0",
  color: "#ddebe1",
  fontSize: "14px",
  lineHeight: "1.6",
}

const rejectedContentText: React.CSSProperties = {
  margin: "0",
  color: "#7a4b4b",
  fontSize: "14px",
  lineHeight: "1.6",
}

const reasonBox: React.CSSProperties = {
  backgroundColor: "#f8e7e7",
  padding: "16px",
  marginTop: "16px",
  border: "1px solid #d08a8a",
}

const notesBox: React.CSSProperties = {
  backgroundColor: "#ffffff",
  padding: "16px",
  marginTop: "16px",
  border: "1px solid #e1e1e1",
}

const detailLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const detailText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
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

export default ComplianceDocumentReviewedEmail
