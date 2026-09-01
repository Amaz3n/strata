import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  contentCard,
  contentLabel,
  contentText,
  eventLabelText,
  fallbackText,
  heading,
  link,
  metaCard,
  metaLabel,
  metaRow,
  metaValue,
  paragraph,
} from "./theme"

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
    <EmailLayout
      preview={previewText}
      subtitle="Project Decision"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
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
    </EmailLayout>
  )
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

