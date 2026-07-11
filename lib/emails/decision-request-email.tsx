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

export interface DecisionRequestEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  projectName?: string | null
  title: string
  description?: string | null
  kind: "request" | "decided" | "reminder"
  decidedApproved?: boolean
  selectedOptionLabel?: string | null
  note?: string | null
  dueDate?: string | null
  options?: Array<{ label: string; costDeltaLabel?: string | null }>
  actionHref: string
  actionLabel: string
}

export function DecisionRequestEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  projectName,
  title,
  description,
  kind,
  decidedApproved,
  selectedOptionLabel,
  note,
  dueDate,
  options,
  actionHref,
  actionLabel,
}: DecisionRequestEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const previewText =
    kind === "request"
      ? `Your decision is needed: ${title}`
      : kind === "reminder"
        ? `Reminder — decision due: ${title}`
        : `Decision recorded: ${title}`
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"

  const eventLabel = kind === "request" ? "Decision Needed" : kind === "reminder" ? "Decision Reminder" : "Decision Recorded"

  const summaryText =
    kind === "request"
      ? "Your project team needs your decision to keep the project moving."
      : kind === "reminder"
        ? "This decision is still waiting on you — the schedule may depend on it."
        : decidedApproved
          ? "The decision has been approved and recorded."
          : "The decision was declined and sent back to your project team."

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
            <Text style={brandSub}>Project Decision</Text>
          </Section>

          <Section style={content}>
            <Text style={eventLabelText}>{eventLabel}</Text>
            <Heading style={heading}>{title}</Heading>

            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>{summaryText}</Text>

            <Section style={metaCard}>
              {projectName ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
                </Text>
              ) : null}
              {dueDate ? (
                <Text style={metaRow}>
                  <span style={metaLabel}>Needed By:</span> <span style={metaValue}>{dueDate}</span>
                </Text>
              ) : null}
            </Section>

            {description ? (
              <Section style={contentCard}>
                <Text style={contentLabel}>Details</Text>
                <Text style={contentText}>{description}</Text>
              </Section>
            ) : null}

            {kind !== "decided" && options && options.length > 0 ? (
              <Section style={contentCard}>
                <Text style={contentLabel}>Options</Text>
                {options.map((option, index) => (
                  <Text key={index} style={optionRow}>
                    {option.label}
                    {option.costDeltaLabel ? ` — ${option.costDeltaLabel}` : ""}
                  </Text>
                ))}
              </Section>
            ) : null}

            {kind === "decided" ? (
              <Section style={decisionCard}>
                <Text style={decisionLabel}>Outcome</Text>
                <Text style={decisionStatusText}>{decidedApproved ? "Approved" : "Declined"}</Text>
                {selectedOptionLabel ? <Text style={decisionContentText}>Selected: {selectedOptionLabel}</Text> : null}
                {note ? <Text style={decisionContentText}>{note}</Text> : null}
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
  margin: "0 0 20px 0",
  color: "#111111",
  fontSize: "28px",
  lineHeight: "1.2",
  fontWeight: 700,
  letterSpacing: "-0.6px",
}

const paragraph: React.CSSProperties = {
  margin: "0 0 12px 0",
  color: "#333333",
  fontSize: "14px",
  lineHeight: "1.6",
}

const metaCard: React.CSSProperties = {
  backgroundColor: "#f7f7f5",
  border: "1px solid #e5e5e2",
  padding: "14px 18px",
  margin: "18px 0",
}

const metaRow: React.CSSProperties = {
  margin: "4px 0",
  fontSize: "13px",
  lineHeight: "1.5",
}

const metaLabel: React.CSSProperties = {
  color: "#6b6b6b",
  fontWeight: 600,
}

const metaValue: React.CSSProperties = {
  color: "#111111",
  fontWeight: 500,
}

const contentCard: React.CSSProperties = {
  border: "1px solid #e5e5e2",
  padding: "14px 18px",
  margin: "18px 0",
}

const contentLabel: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#6b6b6b",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const contentText: React.CSSProperties = {
  margin: "0",
  color: "#111111",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap" as const,
}

const optionRow: React.CSSProperties = {
  margin: "6px 0",
  color: "#111111",
  fontSize: "14px",
  lineHeight: "1.5",
}

const decisionCard: React.CSSProperties = {
  border: "1px solid #d9d9d5",
  backgroundColor: "#f7f7f5",
  padding: "14px 18px",
  margin: "18px 0",
}

const decisionLabel: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#6b6b6b",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const decisionStatusText: React.CSSProperties = {
  margin: "0",
  color: "#111111",
  fontSize: "16px",
  fontWeight: 700,
}

const decisionContentText: React.CSSProperties = {
  margin: "8px 0 0 0",
  color: "#333333",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap" as const,
}

const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  margin: "26px 0 10px 0",
}

const button: React.CSSProperties = {
  backgroundColor: "#111111",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: 600,
  textDecoration: "none",
  padding: "12px 22px",
}

const fallbackText: React.CSSProperties = {
  margin: "10px 0 0 0",
  textAlign: "center",
  color: "#6b6b6b",
  fontSize: "12px",
}

const link: React.CSSProperties = {
  color: "#111111",
  textDecoration: "underline",
}

const hr: React.CSSProperties = {
  borderColor: "#ebebeb",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "16px 40px",
}

const footerText: React.CSSProperties = {
  margin: "0",
  textAlign: "center",
  color: "#9b9b9b",
  fontSize: "12px",
}
