import type { CSSProperties } from "react";
import { fonts, tokens } from "../../kit/brand";
import { INVOICE, money } from "./data";

// The vendor's PDF, drawn as paper. It is the vendor's document, not Arc's, so
// it uses a plain serif letterhead rather than Arc's type.
export const PAPER = { width: 1040, height: 1340 };

// Where each extracted field sits on the paper, so the scene can draw a
// provenance box over it and anchor a chip beside it.
export const FIELD_BOXES = {
  vendor: { x: 80, y: 70, w: 470, h: 130 },
  number: { x: 640, y: 236, w: 320, h: 40 },
  due: { x: 640, y: 316, w: 320, h: 40 },
  lines: { x: 80, y: 560, w: 880, h: 250 },
  total: { x: 600, y: 860, w: 360, h: 64 },
};

const serif = "Georgia, 'Times New Roman', serif";

export function InvoicePaper({ style }: { style?: CSSProperties }) {
  const ink = tokens.paperInk;
  const soft = tokens.paperInkSoft;
  const meta = (label: string, value: string) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, height: 40, alignItems: "center" }}>
      <span style={{ color: soft }}>{label}</span>
      <span style={{ color: ink, fontWeight: 600 }}>{value}</span>
    </div>
  );
  return (
    <div
      style={{
        width: PAPER.width,
        height: PAPER.height,
        background: tokens.paper,
        boxShadow: "0 30px 80px oklch(0.2 0.05 264 / 0.35)",
        fontFamily: serif,
        color: ink,
        position: "relative",
        ...style,
      }}
    >
      <div style={{ position: "absolute", left: 80, top: 80, width: 470 }}>
        <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: "0.01em" }}>{INVOICE.vendor}</div>
        {INVOICE.vendorAddress.map((line) => (
          <div key={line} style={{ fontSize: 21, color: soft, marginTop: 6 }}>
            {line}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", right: 80, top: 84, fontSize: 56, fontWeight: 700, letterSpacing: "0.12em" }}>INVOICE</div>

      <div style={{ position: "absolute", left: 80, top: 236, width: 420 }}>
        <div style={{ fontSize: 17, letterSpacing: "0.16em", color: soft, marginBottom: 10 }}>BILL TO</div>
        {INVOICE.billTo.map((line, i) => (
          <div key={line} style={{ fontSize: 22, fontWeight: i === 0 ? 600 : 400, marginTop: 4 }}>
            {line}
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 640, top: 236, width: 320 }}>
        {meta("Invoice #", INVOICE.number)}
        {meta("Invoice date", INVOICE.date)}
        {meta("Due date", INVOICE.due)}
        {meta("Terms", "Net 30")}
      </div>

      <div style={{ position: "absolute", left: 80, top: 560, width: 880, fontFamily: fonts.sans }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 90px 80px 180px",
            fontSize: 17,
            letterSpacing: "0.12em",
            color: soft,
            paddingBottom: 14,
            borderBottom: `2px solid ${ink}`,
          }}
        >
          <span>DESCRIPTION</span>
          <span style={{ textAlign: "right" }}>QTY</span>
          <span style={{ textAlign: "right" }}>UNIT</span>
          <span style={{ textAlign: "right" }}>AMOUNT</span>
        </div>
        {INVOICE.lines.map((line) => (
          <div
            key={line.description}
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 90px 80px 180px",
              fontSize: 22,
              height: 64,
              alignItems: "center",
              borderBottom: `1px solid ${tokens.paperRule}`,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <span>{line.description}</span>
            <span style={{ textAlign: "right" }}>{line.qty}</span>
            <span style={{ textAlign: "right", color: soft }}>{line.unit}</span>
            <span style={{ textAlign: "right" }}>{money(line.amountCents)}</span>
          </div>
        ))}
      </div>

      <div style={{ position: "absolute", left: 600, top: 860, width: 360, display: "flex", justifyContent: "space-between", alignItems: "center", height: 64, fontFamily: fonts.sans, borderTop: `2px solid ${ink}` }}>
        <span style={{ fontSize: 22, fontWeight: 600 }}>Total due</span>
        <span style={{ fontSize: 32, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{money(INVOICE.totalCents)}</span>
      </div>

      <div style={{ position: "absolute", left: 80, top: 1000, width: 880, fontSize: 19, color: soft, lineHeight: 1.6 }}>
        Please remit by ACH to Gulf Coast Framing LLC. Reference the invoice number with your payment. Thank you for your business.
      </div>
    </div>
  );
}
