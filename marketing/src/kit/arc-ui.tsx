import {
  BarChart3,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Contact,
  CreditCard,
  FileSpreadsheet,
  FolderOpen,
  Gavel,
  Home,
  Receipt,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { Img, staticFile } from "remotion";
import { fonts, tint, tokens } from "./brand";

// Stage replicas of Arc surfaces. They copy the app's markup decisions
// (labels, icons, row heights, badge tones) from the real components named
// beside each one, but take props instead of data so a scene can script them.

// components/layout/app-sidebar.tsx, in its order.
export const SIDEBAR_ITEMS: { title: string; icon: LucideIcon }[] = [
  { title: "Home", icon: Home },
  { title: "Tasks", icon: ClipboardCheck },
  { title: "Projects", icon: FolderOpen },
  { title: "Pipeline", icon: Contact },
  { title: "Purchasing", icon: Receipt },
  { title: "Billing", icon: Wallet },
  { title: "Payables", icon: CreditCard },
  { title: "Bids", icon: Gavel },
  { title: "Schedule", icon: CalendarDays },
  { title: "Documents", icon: FolderOpen },
  { title: "Directory", icon: Building2 },
  { title: "Reports", icon: BarChart3 },
  { title: "Books", icon: FileSpreadsheet },
];

export function Sidebar({ active, activeAmount = 1, style }: { active: string; activeAmount?: number; style?: CSSProperties }) {
  return (
    <div
      style={{
        width: 300,
        background: tokens.sidebar,
        color: tokens.sidebarForeground,
        fontFamily: fonts.sans,
        padding: "28px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        borderRight: `1px solid ${tokens.sidebarBorder}`,
        ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "0 12px 26px" }}>
        <ArcMark size={30} />
        <span style={{ fontSize: 22, fontWeight: 600, color: "white" }}>Gulfstone Homes</span>
      </div>
      {SIDEBAR_ITEMS.map(({ title, icon: Icon }) => {
        const on = title === active ? activeAmount : 0;
        return (
          <div
            key={title}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              height: 46,
              padding: "0 14px",
              fontSize: 19,
              fontWeight: on > 0.5 ? 600 : 500,
              background: on > 0 ? tint(tokens.sidebarAccent, on * 100) : "transparent",
              color: on > 0.5 ? "white" : tokens.sidebarForeground,
              boxShadow: on > 0 ? `inset 3px 0 0 ${tint(tokens.sidebarPrimary, on * 100)}` : "none",
            }}
          >
            <Icon size={20} strokeWidth={1.8} />
            {title}
          </div>
        );
      })}
    </div>
  );
}

export function ArcMark({ size }: { size: number }) {
  return <Img src={staticFile("arc-mark.svg")} width={size} height={size * (521 / 581)} style={{ display: "block" }} />;
}

// PAYABLE_STATUS_TONES in components/payables/payables-ui.tsx.
export type PayableStatus = "Draft" | "Needs approval" | "Approved" | "Paid";
const STATUS_TONE: Record<PayableStatus, { border: string; bg: string; fg: string }> = {
  Draft: { border: tokens.border, bg: tint(tokens.muted, 40), fg: tokens.mutedForeground },
  "Needs approval": { border: tint(tokens.warning, 25), bg: tint(tokens.warning, 10), fg: tokens.warning },
  Approved: { border: tokens.border, bg: tokens.accent, fg: tokens.accentForeground },
  Paid: { border: tint(tokens.success, 25), bg: tint(tokens.success, 10), fg: tokens.success },
};

export function StatusBadge({ status, style }: { status: PayableStatus; style?: CSSProperties }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 30,
        padding: "0 12px",
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.fg,
        fontSize: 17,
        fontWeight: 500,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {status}
    </span>
  );
}

export function Checkbox({ checked }: { checked: number }) {
  return (
    <div
      style={{
        width: 20,
        height: 20,
        border: `1.5px solid ${checked > 0.5 ? tokens.primary : tokens.lineStrong}`,
        background: tint(tokens.primary, checked * 100),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked > 0.5 ? (
        <svg width={14} height={14} viewBox="0 0 24 24">
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </div>
  );
}

// The desk's grid: components/payables/payables-desk.tsx (project view).
export const DESK_COLUMNS = "56px 1.5fr 1fr 0.9fr 1fr 0.9fr";

export function DeskHeader() {
  const cell: CSSProperties = {
    fontSize: 13,
    fontWeight: 600,
    letterSpacing: "0.14em",
    textTransform: "uppercase",
    color: tokens.mutedForeground,
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: DESK_COLUMNS,
        alignItems: "center",
        height: 48,
        padding: "0 28px",
        boxShadow: `inset 0 -1px 0 ${tokens.border}`,
      }}
    >
      <span />
      <span style={cell}>Vendor</span>
      <span style={cell}>Invoice</span>
      <span style={cell}>Due</span>
      <span style={cell}>Status</span>
      <span style={{ ...cell, textAlign: "right" }}>Bill total</span>
    </div>
  );
}

export function BandHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 44,
        padding: "0 28px",
        background: tint(tokens.muted, 40),
        boxShadow: `inset 0 -1px 0 ${tokens.border}`,
        fontSize: 16,
        fontWeight: 600,
        color: tokens.foreground,
      }}
    >
      {label}
      <span style={{ color: tokens.mutedForeground, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>{count}</span>
    </div>
  );
}

export function DeskRow({ checkbox, vendor, invoice, due, dueTone, status, total, style }: {
  checkbox: ReactNode;
  vendor: ReactNode;
  invoice: ReactNode;
  due: ReactNode;
  dueTone?: "warning" | "normal";
  status: ReactNode;
  total: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: DESK_COLUMNS,
        alignItems: "center",
        height: 72,
        padding: "0 28px",
        boxShadow: `inset 0 -1px 0 ${tokens.border}`,
        background: tokens.background,
        ...style,
      }}
    >
      {checkbox}
      <span style={{ fontSize: 20, fontWeight: 500, color: tokens.foreground, whiteSpace: "nowrap", overflow: "hidden" }}>{vendor}</span>
      <span style={{ fontSize: 18, color: tokens.mutedForeground }}>{invoice}</span>
      <span style={{ fontSize: 18, fontVariantNumeric: "tabular-nums", color: dueTone === "warning" ? tokens.warning : tokens.foreground }}>{due}</span>
      <span>{status}</span>
      <span style={{ textAlign: "right", fontSize: 21, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: tokens.foreground }}>{total}</span>
    </div>
  );
}

// The desk's page frame: breadcrumb, title, toolbar.
export function DeskFrame({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ background: tokens.background, fontFamily: fonts.sans, color: tokens.foreground, display: "flex", flexDirection: "column", ...style }}>
      <div style={{ padding: "30px 28px 0", fontSize: 17, color: tokens.mutedForeground }}>Magnolia Residence</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 28px 22px" }}>
        <div style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em" }}>Payables</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ height: 44, width: 280, border: `1px solid ${tokens.border}`, background: tokens.card, display: "flex", alignItems: "center", padding: "0 14px", fontSize: 17, color: tokens.mutedForeground }}>
            Search payables…
          </div>
          <div style={{ height: 44, padding: "0 18px", background: tokens.primary, color: tokens.primaryForeground, display: "flex", alignItems: "center", gap: 8, fontSize: 17, fontWeight: 500 }}>
            <span style={{ fontSize: 22, lineHeight: 1 }}>+</span> Add bill
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

// Grey placeholder text that shimmers while a value is still being read, the
// same idea as intake-status.module.css.
export function Reading({ text, frame }: { text: string; frame: number }) {
  const x = ((frame * 4) % 300) - 100;
  return (
    <span
      style={{
        backgroundImage: `linear-gradient(90deg, ${tokens.mutedForeground} ${x}%, ${tokens.lineStrong} ${x + 20}%, ${tokens.mutedForeground} ${x + 40}%)`,
        WebkitBackgroundClip: "text",
        backgroundClip: "text",
        color: "transparent",
        fontWeight: 400,
        fontSize: 18,
      }}
    >
      {text}
    </span>
  );
}
