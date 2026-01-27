import {
  Body,
  Button,
  Column,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
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
}

export function InvoiceReminderEmail({
  recipientName,
  invoiceNumber = "INV-001",
  amount = "$0.00",
  dueDate = "",
  daysOverdue,
  payLink = "#",
}: InvoiceReminderEmailProps) {
  const isOverdue = daysOverdue && daysOverdue > 0
  const previewText = isOverdue
    ? `Invoice ${invoiceNumber} is ${daysOverdue} days overdue`
    : `Reminder: Invoice ${invoiceNumber} due ${dueDate}`

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Text style={logoText}>Arc</Text>
          </Section>

          <Section style={content}>
            <Heading style={heading}>
              {isOverdue ? "Payment Overdue" : "Payment Reminder"}
            </Heading>

            <Text style={paragraph}>
              Dear {recipientName || "Valued Customer"},
            </Text>

            <Text style={paragraph}>
              {isOverdue
                ? `This is a reminder that your payment for invoice ${invoiceNumber} is now ${daysOverdue} days overdue. Please make your payment at your earliest convenience.`
                : `This is a friendly reminder that payment for invoice ${invoiceNumber} is due on ${dueDate}.`}
            </Text>

            <Section style={isOverdue ? invoiceCardOverdue : invoiceCard}>
              <Row>
                <Column style={invoiceDetailColumn}>
                  <Text style={invoiceLabel}>Invoice Number</Text>
                  <Text style={invoiceValue}>{invoiceNumber}</Text>
                </Column>
                <Column style={invoiceDetailColumn}>
                  <Text style={invoiceLabel}>Amount Due</Text>
                  <Text style={invoiceValueHighlight}>{amount}</Text>
                </Column>
              </Row>
              <Hr style={divider} />
              <Row>
                <Column style={invoiceDetailColumn}>
                  <Text style={invoiceLabel}>Due Date</Text>
                  <Text style={invoiceValue}>{dueDate}</Text>
                </Column>
                {isOverdue && (
                  <Column style={invoiceDetailColumn}>
                    <Text style={invoiceLabel}>Days Overdue</Text>
                    <Text style={overdueValue}>{daysOverdue}</Text>
                  </Column>
                )}
              </Row>
            </Section>

            <Section style={buttonContainer}>
              <Button style={isOverdue ? buttonUrgent : button} href={payLink}>
                Pay Now
              </Button>
            </Section>

            <Text style={helpText}>
              If you have already made this payment, please disregard this reminder.
              Thank you for your business.
            </Text>
          </Section>

          <Section style={footer}>
            <Text style={footerText}>
              This reminder was sent via Arc. If you have any questions about
              this invoice, please contact the sender directly.
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
  fontSize: "28px",
  fontWeight: "700",
  lineHeight: "1.3",
  margin: "0 0 24px 0",
}

const paragraph: React.CSSProperties = {
  color: "#4b5563",
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 16px 0",
}

const invoiceCard: React.CSSProperties = {
  backgroundColor: "#f9fafb",
  borderRadius: "12px",
  padding: "24px",
  marginTop: "8px",
  marginBottom: "24px",
  border: "1px solid #e5e7eb",
}

const invoiceCardOverdue: React.CSSProperties = {
  backgroundColor: "#fef2f2",
  borderRadius: "12px",
  padding: "24px",
  marginTop: "8px",
  marginBottom: "24px",
  border: "1px solid #fecaca",
}

const invoiceDetailColumn: React.CSSProperties = {
  width: "50%",
}

const invoiceLabel: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "12px",
  fontWeight: "500",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  margin: "0 0 4px 0",
}

const invoiceValue: React.CSSProperties = {
  color: "#111827",
  fontSize: "16px",
  fontWeight: "600",
  margin: "0",
}

const invoiceValueHighlight: React.CSSProperties = {
  color: "#111827",
  fontSize: "20px",
  fontWeight: "700",
  margin: "0",
}

const overdueValue: React.CSSProperties = {
  color: "#dc2626",
  fontSize: "16px",
  fontWeight: "700",
  margin: "0",
}

const divider: React.CSSProperties = {
  borderColor: "#e5e7eb",
  borderWidth: "1px",
  margin: "16px 0",
}

const buttonContainer: React.CSSProperties = {
  textAlign: "center",
  marginBottom: "24px",
}

const button: React.CSSProperties = {
  backgroundColor: "#111827",
  borderRadius: "8px",
  color: "#ffffff",
  fontSize: "16px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center",
  padding: "14px 32px",
  display: "inline-block",
}

const buttonUrgent: React.CSSProperties = {
  backgroundColor: "#dc2626",
  borderRadius: "8px",
  color: "#ffffff",
  fontSize: "16px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center",
  padding: "14px 32px",
  display: "inline-block",
}

const helpText: React.CSSProperties = {
  color: "#6b7280",
  fontSize: "14px",
  lineHeight: "1.5",
  margin: "0",
  textAlign: "center",
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

export default InvoiceReminderEmail
