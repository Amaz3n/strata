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
  subjectText,
} from "./theme"

export interface InvoiceEmailProps {
  invoiceNumber: string
  invoiceTitle: string
  projectName: string
  amount: string
  dueDate?: string
  invoiceLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
  companyName?: string | null
}

export function InvoiceEmail({
  invoiceNumber = "INV-001",
  invoiceTitle = "New Invoice",
  projectName = "Project",
  amount = "$0.00",
  dueDate,
  invoiceLink = "#",
  orgName,
  orgLogoUrl,
  companyName,
}: InvoiceEmailProps) {
  const displayOrgName = orgName ?? companyName ?? "Arc"
  const previewText = `Invoice ${invoiceNumber} from ${displayOrgName}`

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Invoice Notification"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>New Invoice</Text>
      <Heading style={heading}>Invoice #{invoiceNumber}</Heading>
      <Text style={subjectText}>{invoiceTitle}</Text>

      <Text style={paragraph}>
        You received a new invoice from <strong>{displayOrgName}</strong>.
      </Text>
      <Text style={paragraph}>Review the invoice and submit payment securely in Arc.</Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Invoice:</span> <span style={metaValue}>{invoiceNumber}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Amount Due:</span> <span style={amountValue}>{amount}</span>
        </Text>
        {dueDate ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Due Date:</span> <span style={metaValue}>{dueDate}</span>
          </Text>
        ) : null}
      </Section>

      <Section style={contentCard}>
        <Text style={contentLabel}>Payment</Text>
        <Text style={contentText}>
          Open the invoice to review line items, notes, and full payment details.
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={invoiceLink}>
          View Invoice
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={invoiceLink} style={link}>
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

export default InvoiceEmail
