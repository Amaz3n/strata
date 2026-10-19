import { CameraMotionBlur } from "@remotion/motion-blur";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { ArcMark, BandHeader, Checkbox, DeskHeader, DeskRow, Reading, StatusBadge, type PayableStatus } from "../../kit/arc-ui";
import { fonts, tint, tokens } from "../../kit/brand";
import { Background, Camera, Headline } from "../../kit/canvas";
import { fade, pop } from "../../kit/motion";
import { AiChip, ClickRipple, Cursor, PdfFile, WorkingLabel } from "../../kit/pieces";
import { ALREADY_READY, DROPPED, DROPPED_TOTAL, money, type Bill } from "./data";
import { FIELD_BOXES, InvoicePaper, PAPER } from "./invoice-paper";
import { AppWindow, CHECK_X, DESK, WIN } from "./window";

const CENTER = { x: 960, y: 540, scale: 1 };

// 1 — the hook.
export function Hook() {
  const frame = useCurrentFrame();
  const a = pop(frame, 4);
  const b = fade(frame, 26, 14);
  return (
    <AbsoluteFill>
      <Background />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 28 }}>
        <Headline size={110} style={{ opacity: a, transform: `translateY(${(1 - a) * 30}px)` }}>
          Stop retyping invoices.
        </Headline>
        <Headline size={46} style={{ fontWeight: 400, opacity: b * 0.85, transform: `translateY(${(1 - b) * 12}px)` }}>
          Drop the PDF. Arc reads it.
        </Headline>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

// The rows already on the desk before anything is dropped.
function ReadyBand() {
  return (
    <>
      <BandHeader label="Ready to pay" count={ALREADY_READY.length} />
      {ALREADY_READY.map((bill) => (
        <DeskRow
          key={bill.invoice}
          checkbox={<Checkbox checked={0} />}
          vendor={bill.vendor}
          invoice={bill.invoice}
          due={bill.due}
          status={<StatusBadge status="Approved" />}
          total={money(bill.totalCents)}
        />
      ))}
    </>
  );
}

// 2 — into the sidebar, down to Payables, out to the desk.
export function SidebarZoom() {
  const frame = useCurrentFrame();
  const payablesY = WIN.y + 84 + 6 * 50 + 23;
  const activeAmount = fade(frame, 34, 8);
  return (
    <AbsoluteFill>
      <Background />
      <CameraMotionBlur shutterAngle={200} samples={8}>
        <Camera
          keys={[
            { at: 0, x: 360, y: WIN.y + 84 + 3 * 50, scale: 3.2 },
            { at: 30, x: 360, y: payablesY, scale: 3.2 },
            { at: 52, x: 360, y: payablesY, scale: 3.1 },
            { at: 92, ...CENTER },
          ]}
        >
          <AppWindow activeAmount={activeAmount}>
            <DeskHeader />
            <ReadyBand />
          </AppWindow>
        </Camera>
      </CameraMotionBlur>
    </AbsoluteFill>
  );
}

// 3 — three PDFs dragged onto the desk.
export function DropFiles() {
  const frame = useCurrentFrame();
  const over = fade(frame, 34, 8) * (1 - fade(frame, 66, 10));
  const dropAt = 58;
  const filesIn = 1 - fade(frame, dropAt, 8);
  const rowsIn = fade(frame, 70, 10);
  return (
    <AbsoluteFill>
      <Background />
      <Camera keys={[{ at: 0, x: 1110, y: 520, scale: 1.12 }, { at: 110, x: 1110, y: 540, scale: 1.18 }]}>
        <AppWindow>
          <DeskHeader />
          <div style={{ opacity: rowsIn, height: rowsIn * (DESK.bandHeight + DROPPED.length * DESK.rowHeight), overflow: "hidden" }}>
            <BandHeader label="Drafts" count={DROPPED.length} />
            {DROPPED.map((bill, i) => (
              <DraftRow key={bill.invoice} bill={bill} readAt={999} index={i} />
            ))}
          </div>
          <ReadyBand />
          <div
            style={{
              position: "absolute",
              inset: 12,
              opacity: over,
              border: `3px dashed ${tint(tokens.primary, 60)}`,
              background: tint(tokens.primary, 7),
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              fontFamily: fonts.sans,
            }}
          >
            <div style={{ fontSize: 38, fontWeight: 600, color: tokens.foreground }}>Drop invoices to create drafts</div>
            <div style={{ fontSize: 22, color: tokens.mutedForeground }}>Each invoice gets its own row. Arc scans while you keep working.</div>
          </div>
        </AppWindow>
        <Cursor
          keys={[
            { at: 0, x: 1900, y: 1000, press: 0 },
            { at: 44, x: 1250, y: 450, press: 0 },
            { at: dropAt - 2, x: 1250, y: 450, press: 0 },
            { at: dropAt, x: 1250, y: 450, press: 1 },
            { at: dropAt + 6, x: 1250, y: 450, press: 0 },
            { at: 110, x: 1210, y: 640, press: 0 },
          ]}
        >
          <div style={{ position: "absolute", left: -40, top: -60, opacity: filesIn, transform: `scale(${0.7 + filesIn * 0.3})` }}>
            <PdfFile rotate={-10} style={{ position: "absolute", left: -30, top: 6 }} />
            <PdfFile rotate={6} style={{ position: "absolute", left: 24, top: 0 }} />
            <PdfFile rotate={-2} style={{ position: "absolute", left: -4, top: -10 }} />
            <div
              style={{
                position: "absolute",
                left: 120,
                top: -20,
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: tokens.primary,
                color: "white",
                fontFamily: fonts.sans,
                fontWeight: 600,
                fontSize: 22,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              3
            </div>
          </div>
        </Cursor>
        <ClickRipple x={1250} y={450} at={dropAt} />
      </Camera>
    </AbsoluteFill>
  );
}

// A row from a dropped file: shimmering until its values arrive at `readAt`,
// the way streamed partials fill the real row in.
function DraftRow({ bill, readAt, index, status = "Draft", checked = 0 }: {
  bill: Bill;
  readAt: number;
  index: number;
  status?: PayableStatus;
  checked?: number;
}) {
  const frame = useCurrentFrame();
  const at = readAt + index * 14;
  const vendorIn = fade(frame, at, 8);
  const numberIn = fade(frame, at + 8, 8);
  const totalIn = fade(frame, at + 16, 8);
  const reading = index === 0 ? "Identifying vendor" : index === 1 ? "Reading PDF" : "Uploading invoice";
  return (
    <DeskRow
      checkbox={<Checkbox checked={checked} />}
      vendor={vendorIn > 0 ? <span style={{ opacity: vendorIn }}>{bill.vendor}</span> : <Reading text={reading} frame={frame + index * 20} />}
      invoice={numberIn > 0 ? <span style={{ opacity: numberIn }}>{bill.invoice}</span> : ""}
      due={numberIn > 0 ? <span style={{ opacity: numberIn }}>{bill.due}</span> : "—"}
      dueTone={numberIn > 0 && bill.dueTone === "warning" ? "warning" : "normal"}
      status={<StatusBadge status={status} />}
      total={totalIn > 0 ? <span style={{ opacity: totalIn }}>{money(bill.totalCents)}</span> : <span style={{ color: tokens.mutedForeground }}>—</span>}
    />
  );
}

// 4 — the close-up: Arc reads the invoice.
export function ReadInvoice() {
  const frame = useCurrentFrame();
  const paperLeft = 960 - PAPER.width / 2;
  const paperTop = 190;
  const scanY = interpolate(frame, [6, 70], [0, PAPER.height * 0.75], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const scanOpacity = interpolate(frame, [6, 14, 62, 76], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const box = (key: keyof typeof FIELD_BOXES, at: number) => {
    const b = FIELD_BOXES[key];
    const p = pop(frame, at, 200);
    if (frame < at) return null;
    return (
      <div
        key={key}
        style={{
          position: "absolute",
          left: paperLeft + b.x - 10,
          top: paperTop + b.y - 8,
          width: b.w + 20,
          height: b.h + 16,
          border: `3px solid ${tint(tokens.primary, 80)}`,
          background: tint(tokens.primary, 6),
          opacity: p,
          transform: `scale(${1.04 - p * 0.04})`,
        }}
      />
    );
  };
  return (
    <AbsoluteFill>
      <Background />
      <Camera keys={[{ at: 0, x: 960, y: 560, scale: 0.86 }, { at: 180, x: 960, y: 600, scale: 0.94 }]}>
        <InvoicePaper style={{ position: "absolute", left: paperLeft, top: paperTop }} />
        <div
          style={{
            position: "absolute",
            left: paperLeft,
            top: paperTop + scanY - 120,
            width: PAPER.width,
            height: 120,
            opacity: scanOpacity,
            background: `linear-gradient(180deg, transparent, ${tint(tokens.primary, 16)} 85%, ${tint(tokens.primary, 70)})`,
            borderBottom: `2px solid ${tokens.primary}`,
          }}
        />
        {box("vendor", 44)}
        {box("number", 70)}
        {box("due", 88)}
        {box("total", 106)}
        {box("lines", 128)}
        <AiChip label="Vendor" x={paperLeft - 210} y={paperTop + 100} at={48} />
        <AiChip label="Invoice number" x={paperLeft + PAPER.width - 40} y={paperTop + 210} at={74} />
        <AiChip label="Due date" x={paperLeft + PAPER.width - 20} y={paperTop + 310} at={92} />
        <AiChip label="Total" x={paperLeft + PAPER.width - 40} y={paperTop + 866} at={110} />
        <AiChip label="Line items" x={paperLeft - 250} y={paperTop + 640} at={132} />
      </Camera>
      <WorkingLabel
        y={64}
        steps={[
          { at: 0, text: "Reading PDF" },
          { at: 40, text: "Identifying vendor" },
          { at: 96, text: "Reading invoice amount" },
          { at: 124, text: "Reading line items" },
          { at: 158, text: "Draft ready for review" },
        ]}
      />
    </AbsoluteFill>
  );
}

// The bulk-action footer, pinned to the bottom of what the camera shows.
const FOOTER_BOTTOM = 900;

// The bulk-action footer pinned under the desk.
function SelectionFooter({ shown, label }: { shown: number; label: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: WIN.y + WIN.h - FOOTER_BOTTOM,
        height: 84,
        transform: `translateY(${(1 - shown) * 140}px)`,
        background: tokens.card,
        boxShadow: `0 -1px 0 ${tokens.border}, 0 -12px 30px oklch(0.2 0.05 264 / 0.08)`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 28px",
        fontFamily: fonts.sans,
      }}
    >
      <span style={{ fontSize: 20, color: tokens.foreground }}>
        <b style={{ fontWeight: 600 }}>{DROPPED.length} selected</b>
        <span style={{ color: tokens.mutedForeground }}> · {money(DROPPED_TOTAL)}</span>
      </span>
      <span style={{ height: 48, padding: "0 22px", background: tokens.primary, color: tokens.primaryForeground, display: "flex", alignItems: "center", fontSize: 19, fontWeight: 500 }}>
        {label}
      </span>
    </div>
  );
}

const FOOTER_BUTTON = { x: WIN.x + WIN.w - 28 - 110, y: FOOTER_BOTTOM - 42 };
const HEADER_CHECK_Y = DESK.headerTop + DESK.headerHeight / 2;

// 5 — back on the desk: the drafts fill in, get selected, go for approval.
export function DraftsFill() {
  const frame = useCurrentFrame();
  const checked = fade(frame, 62, 4);
  const footer = pop(frame, 66);
  const submittedAt = 104;
  return (
    <AbsoluteFill>
      <Background />
      <Camera keys={[{ at: 0, x: 1110, y: 540, scale: 1.18 }, { at: 150, x: 1110, y: 560, scale: 1.12 }]}>
        <AppWindow>
          <DeskHeaderWithCheck checked={checked} />
          <BandHeader label={frame < submittedAt ? "Drafts" : "Needs approval"} count={DROPPED.length} />
          {DROPPED.map((bill, i) => (
            <DraftRow
              key={bill.invoice}
              bill={bill}
              readAt={6}
              index={i}
              checked={checked}
              status={frame >= submittedAt + i * 4 ? "Needs approval" : "Draft"}
            />
          ))}
          <ReadyBand />
          <SelectionFooter shown={footer * (1 - fade(frame, submittedAt + 14, 10))} label={`Submit ${DROPPED.length} for approval`} />
        </AppWindow>
        <Cursor
          keys={[
            { at: 30, x: 1300, y: 760, press: 0 },
            { at: 56, x: CHECK_X, y: HEADER_CHECK_Y, press: 0 },
            { at: 60, x: CHECK_X, y: HEADER_CHECK_Y, press: 1 },
            { at: 64, x: CHECK_X, y: HEADER_CHECK_Y, press: 0 },
            { at: 94, x: FOOTER_BUTTON.x, y: FOOTER_BUTTON.y, press: 0 },
            { at: 100, x: FOOTER_BUTTON.x, y: FOOTER_BUTTON.y, press: 1 },
            { at: 104, x: FOOTER_BUTTON.x, y: FOOTER_BUTTON.y, press: 0 },
            { at: 150, x: FOOTER_BUTTON.x - 120, y: FOOTER_BUTTON.y - 80, press: 0 },
          ]}
        />
        <ClickRipple x={CHECK_X} y={HEADER_CHECK_Y} at={60} />
        <ClickRipple x={FOOTER_BUTTON.x} y={FOOTER_BUTTON.y} at={100} />
      </Camera>
    </AbsoluteFill>
  );
}

function DeskHeaderWithCheck({ checked }: { checked: number }) {
  return (
    <div style={{ position: "relative" }}>
      <DeskHeader />
      <div style={{ position: "absolute", left: 28, top: 14 }}>
        <Checkbox checked={checked} />
      </div>
    </div>
  );
}

// 6 — approve them in one click, then push in on the result.
export function Approve() {
  const frame = useCurrentFrame();
  const checked = fade(frame, 22, 4);
  const footer = pop(frame, 26);
  const approvedAt = 64;
  const toast = pop(frame, approvedAt + 6) * (1 - fade(frame, 150, 10));
  const firstRowY = DESK.headerTop + DESK.headerHeight + DESK.bandHeight + DESK.rowHeight / 2;
  return (
    <AbsoluteFill>
      <Background />
      <Camera
        keys={[
          { at: 0, x: 1110, y: 560, scale: 1.12 },
          { at: approvedAt + 16, x: 1110, y: 560, scale: 1.12 },
          { at: approvedAt + 60, x: 1240, y: firstRowY + DESK.rowHeight * 0.6, scale: 1.7 },
          { at: 170, x: 1260, y: firstRowY + DESK.rowHeight * 0.6, scale: 1.78 },
        ]}
      >
        <AppWindow>
          <DeskHeaderWithCheck checked={checked * (1 - fade(frame, approvedAt + 10, 4))} />
          <BandHeader label="Needs approval" count={DROPPED.length} />
          {DROPPED.map((bill, i) => (
            <DraftRow
              key={bill.invoice}
              bill={bill}
              readAt={-100}
              index={i}
              checked={checked * (1 - fade(frame, approvedAt + 10, 4))}
              status={frame >= approvedAt + 4 + i * 5 ? "Approved" : "Needs approval"}
            />
          ))}
          <ReadyBand />
          <SelectionFooter shown={footer * (1 - fade(frame, approvedAt + 8, 10))} label={`Approve ${DROPPED.length} payables`} />
        </AppWindow>
        <Cursor
          keys={[
            { at: 0, x: 1300, y: 800, press: 0 },
            { at: 16, x: CHECK_X, y: HEADER_CHECK_Y, press: 0 },
            { at: 20, x: CHECK_X, y: HEADER_CHECK_Y, press: 1 },
            { at: 24, x: CHECK_X, y: HEADER_CHECK_Y, press: 0 },
            { at: 54, x: FOOTER_BUTTON.x, y: FOOTER_BUTTON.y, press: 0 },
            { at: 60, x: FOOTER_BUTTON.x, y: FOOTER_BUTTON.y, press: 1 },
            { at: 64, x: FOOTER_BUTTON.x, y: FOOTER_BUTTON.y, press: 0 },
            { at: 110, x: FOOTER_BUTTON.x + 300, y: FOOTER_BUTTON.y + 200, press: 0 },
          ]}
        />
        <ClickRipple x={CHECK_X} y={HEADER_CHECK_Y} at={20} />
        <ClickRipple x={FOOTER_BUTTON.x} y={FOOTER_BUTTON.y} at={60} />
      </Camera>
      <div
        style={{
          position: "absolute",
          left: "50%",
          bottom: 64,
          transform: `translate(-50%, ${(1 - toast) * 40}px)`,
          opacity: toast,
          background: tokens.card,
          boxShadow: "0 16px 40px oklch(0.2 0.05 264 / 0.3)",
          padding: "26px 40px",
          display: "flex",
          alignItems: "center",
          gap: 18,
          fontFamily: fonts.sans,
          fontSize: 36,
          fontWeight: 500,
          color: tokens.foreground,
        }}
      >
        <svg width={38} height={38} viewBox="0 0 24 24">
          <circle cx={12} cy={12} r={11} fill={tokens.success} />
          <path d="M7 12.5l3.3 3.3L17 9" fill="none" stroke="white" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {DROPPED.length} payables approved
      </div>
    </AbsoluteFill>
  );
}

// 7 — the end card.
export function EndCard() {
  const frame = useCurrentFrame();
  const mark = pop(frame, 4, 120);
  const line = fade(frame, 20, 14);
  return (
    <AbsoluteFill>
      <Background />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", gap: 40 }}>
        <div style={{ transform: `scale(${0.6 + mark * 0.4})`, opacity: mark, background: "white", padding: 26, boxShadow: "0 20px 60px oklch(0.15 0.05 264 / 0.35)" }}>
          <ArcMark size={120} />
        </div>
        <Headline size={78} style={{ opacity: line, transform: `translateY(${(1 - line) * 14}px)` }}>
          Bills in. Ready to pay.
        </Headline>
        <Headline size={34} style={{ fontWeight: 400, opacity: fade(frame, 34, 14) * 0.85 }}>
          Payables in Arc
        </Headline>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
