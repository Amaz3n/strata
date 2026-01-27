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

export interface InvoiceEmailProps {
  invoiceNumber: string
  invoiceTitle: string
  projectName: string
  amount: string
  dueDate?: string
  invoiceLink: string
  companyName?: string
}

export function InvoiceEmail({
  invoiceNumber = "INV-001",
  invoiceTitle = "New Invoice",
  projectName = "Project",
  amount = "$0.00",
  dueDate,
  invoiceLink = "#",
  companyName,
}: InvoiceEmailProps) {
  const previewText = `Invoice ${invoiceNumber} for ${projectName}`

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            <Text style={logoText}>{companyName || "Arc"}</Text>
          </Section>

          <Section style={content}>
            <Heading style={heading}>New Invoice</Heading>
            <Text style={paragraph}>
              You have received a new invoice for <strong>{projectName}</strong>.
            </Text>

            <Section style={invoiceCard}>
              <Row>
                <Column style={invoiceDetailColumn}>
                  <Text style={invoiceLabel}>Invoice</Text>
                  <Text style={invoiceValue}>{invoiceNumber}</Text>
                </Column>
                <Column style={invoiceDetailColumn}>
                  <Text style={invoiceLabel}>Amount</Text>
                  <Text style={invoiceValueHighlight}>{amount}</Text>
                </Column>
              </Row>
              {dueDate && (
                <Row style={invoiceRow}>
                  <Column>
                    <Text style={invoiceLabel}>Due Date</Text>
                    <Text style={invoiceValue}>{dueDate}</Text>
                  </Column>
                </Row>
              )}
              <Hr style={divider} />
              <Text style={invoiceTitleText}>{invoiceTitle}</Text>
            </Section>

            <Section style={buttonContainer}>
              <Button style={button} href={invoiceLink}>
                View Invoice
              </Button>
            </Section>

            <Text style={helpText}>
              Click the button above to view the full invoice details and make a payment.
            </Text>
          </Section>

          <Section style={footer}>
            <Text style={footerText}>
              This invoice was sent via Arc. If you have any questions, please
              contact the sender directly.
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
  margin: "0 0 16px 0",
}

const paragraph: React.CSSProperties = {
  color: "#4b5563",
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 24px 0",
}

const invoiceCard: React.CSSProperties = {
  backgroundColor: "#f9fafb",
  borderRadius: "12px",
  padding: "24px",
  marginBottom: "24px",
  border: "1px solid #e5e7eb",
}

const invoiceRow: React.CSSProperties = {
  marginTop: "16px",
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

const divider: React.CSSProperties = {
  borderColor: "#e5e7eb",
  borderWidth: "1px",
  margin: "20px 0",
}

const invoiceTitleText: React.CSSProperties = {
  color: "#374151",
  fontSize: "15px",
  fontWeight: "500",
  margin: "0",
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

export default InvoiceEmail
