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

export interface RfiNotificationEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  audience: "internal" | "client" | "sub"
  projectName?: string | null
  rfiNumber: number | string
  subject: string
  question?: string | null
  kind: "created" | "response" | "decision"
  message?: string | null
  decisionStatus?: string | null
  decisionNote?: string | null
  priority?: string | null
  dueDate?: string | null
  actionHref: string
  actionLabel: string
}

export function RfiNotificationEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  audience,
  projectName,
  rfiNumber,
  subject,
  question,
  kind,
  message,
  decisionStatus,
  decisionNote,
  priority,
  dueDate,
  actionHref,
  actionLabel,
}: RfiNotificationEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const previewText =
    kind === "created"
      ? `RFI #${rfiNumber} is ready for review`
      : kind === "response"
        ? `New response on RFI #${rfiNumber}`
        : `Decision posted on RFI #${rfiNumber}`
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"

  const eventLabel = kind === "created" ? "New RFI" : kind === "response" ? "Response Added" : "Decision Posted"

  const audienceLabel =
    audience === "internal"
      ? "Arc Team"
      : audience === "sub"
        ? "Trade Partner"
        : "Project Stakeholder"

  const summaryText =
    kind === "created"
      ? "A new RFI has been issued and is ready for review."
      : kind === "response"
        ? "There is a new update in the RFI thread."
        : "A final decision has been recorded for this RFI."

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
            <Text style={brandSub}>Request for Information</Text>
          </Section>

          <Section style={content}>
            <Text style={eventLabelText}>{eventLabel}</Text>
            <Heading style={heading}>RFI #{rfiNumber}</Heading>
            <Text style={subjectText}>{subject}</Text>

            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>{summaryText}</Text>

            <Section style={metaCard}>
              {projectName ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
                </Text>
              ) : null}
              <Text style={metaRow}>
                <span style={metaLabel}>Audience:</span> <span style={metaValue}>{audienceLabel}</span>
              </Text>
              <Text style={metaRow}>
                <span style={metaLabel}>Priority:</span>{" "}
                <span style={metaValue}>{priority ? priority.toUpperCase() : "NORMAL"}</span>
              </Text>
              {dueDate ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Due Date:</span> <span style={metaValue}>{dueDate}</span>
                </Text>
              ) : null}
            </Section>

            {kind === "created" ? (
              <Section style={contentCard}>
                <Text style={contentLabel}>Question</Text>
                <Text style={contentText}>{question ?? "No question body was provided."}</Text>
              </Section>
            ) : null}

            {kind === "response" ? (
              <Section style={contentCard}>
                <Text style={contentLabel}>Latest Response</Text>
                <Text style={contentText}>{message ?? "A new response was posted."}</Text>
              </Section>
            ) : null}

            {kind === "decision" ? (
              <Section style={decisionCard}>
                <Text style={decisionLabel}>Decision</Text>
                <Text style={decisionStatusText}>{decisionStatus ?? "Updated"}</Text>
                {decisionNote ? <Text style={decisionContentText}>{decisionNote}</Text> : null}
              </Section>
            ) : null}

            <Section style={buttonWrap}>
              <Button style={button} href={actionHref}>
                {actionLabel}
              </Button>
            </Section>

            <Text style={fallbackText}>
              If the button does not open,{" "}
              <Link href={actionHref} style={link}>
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
  fontSize: "36px",
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

const contentCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#ffffff",
}

const decisionCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "2px solid #1fca84",
  backgroundColor: "#0f3a2e",
}

const contentLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const decisionLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#9ab7aa",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const contentText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

const decisionStatusText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#22e38a",
  fontWeight: 700,
  fontSize: "16px",
  textTransform: "capitalize",
}

const decisionContentText: React.CSSProperties = {
  margin: "0",
  color: "#a9c3b7",
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

export default RfiNotificationEmail
