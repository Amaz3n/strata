"use strict"

/**
 * The invoice document the customer sees (`ArcInvoiceDocument`,
 * components/invoices/arc-invoice-document.tsx). Its dates are calendar dates:
 * a US-timezone viewer must see the same day the builder typed.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

require("../scripts/register-ts-node-test")
const React = require("react")
const { renderToStaticMarkup } = require("react-dom/server")
const { ArcInvoiceDocument } = require("@/components/invoices/arc-invoice-document")

test("issue and due dates print as typed in a US timezone", () => {
  const previous = process.env.TZ
  process.env.TZ = "America/New_York"
  try {
    const html = renderToStaticMarkup(
      React.createElement(ArcInvoiceDocument, {
        width: 816,
        height: 1056,
        lines: [],
        data: {
          invoiceNumber: "INV-1",
          issueDate: "2026-09-06",
          dueDate: "2026-09-21",
          fromLines: [],
          billToLines: [],
          subtotalCents: 0,
          taxCents: 0,
          totalCents: 0,
        },
      }),
    )
    assert.match(html, /September 6, 2026/)
    assert.match(html, /September 21, 2026/)
    assert.doesNotMatch(html, /September 5, 2026/)
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})
