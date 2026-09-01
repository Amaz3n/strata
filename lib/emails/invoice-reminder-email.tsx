import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  eventLabelText,
  fallbackText,
  heading,
  link,
  metaCard,
  metaLabel,
  metaRow,
  metaValue,
  paragraph,
  subjectText,
} from "./theme"

export interface InvoiceReminderEmailProps {
  recipientName: string | null
  invoiceNumber: string
  amount: string
  dueDate: string
  daysOverdue?: number
  payLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
}

export function InvoiceReminderEmail({
  recipientName,
  invoiceNumber = "INV-001",
  amount = "$0.00",
  dueDate = "",
  daysOverdue,
  payLink = "#",
  orgName,
  orgLogoUrl,
}: InvoiceReminderEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const isOverdue = typeof daysOverdue === "number" && daysOverdue > 0
  const previewText = isOverdue
    ? `Invoice ${invoiceNumber} is ${daysOverdue} days overdue`
    : `Reminder: Invoice ${invoiceNumber} due ${dueDate}`
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Invoice Reminder"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>{isOverdue ? "Payment Overdue" : "Payment Reminder"}</Text>
      <Heading style={heading}>Invoice #{invoiceNumber}</Heading>
      <Text style={subjectText}>{isOverdue ? `${daysOverdue} days overdue` : `Due ${dueDate}`}</Text>

      <Text style={paragraph}>{greeting}</Text>

      <Text style={paragraph}>
        {isOverdue
          ? `Payment for invoice ${invoiceNumber} is ${daysOverdue} days overdue. Please submit payment as soon as possible.`
          : `This is a friendly reminder that payment for invoice ${invoiceNumber} is due on ${dueDate}.`}
      </Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Invoice:</span> <span style={metaValue}>{invoiceNumber}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Amount Due:</span> <span style={amountValue}>{amount}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Due Date:</span> <span style={metaValue}>{dueDate}</span>
        </Text>
        {isOverdue ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Days Overdue:</span> <span style={metaValue}>{daysOverdue}</span>
          </Text>
        ) : null}
      </Section>

      <Section style={isOverdue ? overdueCard : reminderCard}>
        <Text style={isOverdue ? overdueLabel : reminderLabel}>
          {isOverdue ? "Action Required" : "Upcoming Due Date"}
        </Text>
        <Text style={isOverdue ? overdueStatusText : reminderStatusText}>
          {isOverdue ? "Payment is overdue" : "Payment reminder"}
        </Text>
        <Text style={isOverdue ? overdueContentText : reminderContentText}>
          {isOverdue
            ? "Use the secure link below to complete payment and avoid further delay."
            : "Use the secure link below to review and pay before the due date."}
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={payLink}>
          {isOverdue ? "Pay Now" : "View & Pay Invoice"}
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={payLink} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

const amountValue: React.CSSProperties = {
  color: "#111111",
  fontSize: "14px",
  fontWeight: 700,
}

const reminderCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "1px solid #e1e1e1",
  backgroundColor: "#ffffff",
}

const overdueCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: "2px solid #d08a8a",
  backgroundColor: "#f3dcdc",
}

const reminderLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const overdueLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#8f4a4a",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const reminderStatusText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#111111",
  fontWeight: 700,
  fontSize: "16px",
}

const overdueStatusText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#b42323",
  fontWeight: 700,
  fontSize: "16px",
}

const reminderContentText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
}

const overdueContentText: React.CSSProperties = {
  margin: "0",
  color: "#7a4b4b",
  fontSize: "14px",
  lineHeight: "1.6",
}

export default InvoiceReminderEmail
