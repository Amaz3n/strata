import React from "react"
import { NextRequest, NextResponse } from "next/server"
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

function formatMoney(cents: number, currency = "USD") {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency })
}

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 12, fontFamily: "Helvetica" },
  title: { fontSize: 22, marginBottom: 8 },
  meta: { marginTop: 12, marginBottom: 16 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  label: { color: "#6b7280" },
  value: { color: "#111827" },
  box: { marginTop: 16, padding: 12, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 6 },
  amount: { fontSize: 18, marginTop: 6 },
})

export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string; receiptId: string }> }) {
  const { token, receiptId } = await params
  const supabase = createServiceSupabaseClient()

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, org_id, project_id, invoice_number, title, issue_date, due_date, total_cents, token, project:projects(name)")
    .eq("token", token)
    .maybeSingle()

  if (invoiceError || !invoice) {
    return new NextResponse("Invoice not found", { status: 404 })
  }

  const { data: receipt, error: receiptError } = await supabase
    .from("receipts")
    .select(
      "id, org_id, invoice_id, payment_id, amount_cents, issued_at, issued_to_email, metadata, payment:payments(amount_cents, method, provider, reference, provider_payment_id, received_at)",
    )
    .eq("id", receiptId)
    .eq("org_id", invoice.org_id)
    .eq("invoice_id", invoice.id)
    .maybeSingle()

  if (receiptError || !receipt) {
    return new NextResponse("Receipt not found", { status: 404 })
  }

  const paidCents = receipt.amount_cents ?? (receipt.payment as any)?.amount_cents ?? 0
  const receivedAt = (receipt.payment as any)?.received_at ?? receipt.issued_at
  const method = (receipt.payment as any)?.method ?? null
  const reference = (receipt.payment as any)?.reference ?? (receipt.payment as any)?.provider_payment_id ?? null
  const projectName = (invoice.project as any)?.name ?? "Project"

  const pdf = await renderToBuffer(
    React.createElement(
      Document,
      null,
      React.createElement(
        Page,
        { size: "LETTER", style: styles.page },
        React.createElement(Text, { style: styles.title }, "Receipt"),
        React.createElement(
          View,
          { style: styles.meta },
          React.createElement(View, { style: styles.row }, [
            React.createElement(Text, { style: styles.label, key: "l1" }, "Invoice"),
            React.createElement(
              Text,
              { style: styles.value, key: "v1" },
              `${invoice.invoice_number ?? ""}${invoice.title ? ` • ${invoice.title}` : ""}`,
            ),
          ]),
          React.createElement(View, { style: styles.row }, [
            React.createElement(Text, { style: styles.label, key: "l2" }, "Project"),
            React.createElement(Text, { style: styles.value, key: "v2" }, projectName),
          ]),
          React.createElement(View, { style: styles.row }, [
            React.createElement(Text, { style: styles.label, key: "l3" }, "Receipt ID"),
            React.createElement(Text, { style: styles.value, key: "v3" }, receipt.id),
          ]),
          React.createElement(View, { style: styles.row }, [
            React.createElement(Text, { style: styles.label, key: "l4" }, "Payment ID"),
            React.createElement(Text, { style: styles.value, key: "v4" }, receipt.payment_id),
          ]),
          React.createElement(View, { style: styles.row }, [
            React.createElement(Text, { style: styles.label, key: "l5" }, "Received"),
            React.createElement(Text, { style: styles.value, key: "v5" }, new Date(receivedAt).toLocaleString("en-US")),
          ]),
          receipt.issued_to_email
            ? React.createElement(View, { style: styles.row }, [
                React.createElement(Text, { style: styles.label, key: "l6" }, "Issued to"),
                React.createElement(Text, { style: styles.value, key: "v6" }, receipt.issued_to_email),
              ])
            : null,
          method || reference
            ? React.createElement(View, { style: styles.row }, [
                React.createElement(Text, { style: styles.label, key: "l7" }, "Payment"),
                React.createElement(Text, { style: styles.value, key: "v7" }, `${method ?? "payment"}${reference ? ` • ${reference}` : ""}`),
              ])
            : null,
        ),
        React.createElement(
          View,
          { style: styles.box },
          React.createElement(Text, { style: styles.label }, "Amount paid"),
          React.createElement(Text, { style: styles.amount }, formatMoney(paidCents)),
        ),
      ),
    ),
  )

  const filename = `receipt-${invoice.invoice_number ?? invoice.id}-${receipt.id}.pdf`
  const body = new Uint8Array(pdf)
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}

export const runtime = "nodejs"
