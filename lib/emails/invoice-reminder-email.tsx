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
            <Text style={brandSub}>Invoice Reminder</Text>
          </Section>

          <Section style={content}>
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

export default InvoiceReminderEmail
