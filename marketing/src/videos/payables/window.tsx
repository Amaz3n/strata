import type { ReactNode } from "react";
import { tokens } from "../../kit/brand";
import { DeskFrame, Sidebar } from "../../kit/arc-ui";

// The app sits on the canvas as one large window that bleeds off the bottom
// edge. Scenes place the cursor and camera in stage pixels, so the window's
// geometry is spelled out here once.
export const WIN = { x: 160, y: 100, w: 1700, h: 1040 };
export const SIDEBAR_W = 300;
export const DESK = {
  left: WIN.x + SIDEBAR_W,
  right: WIN.x + WIN.w,
  headerTop: WIN.y + 128,
  rowHeight: 72,
  bandHeight: 44,
  headerHeight: 48,
};
// x of the checkbox column's centre.
export const CHECK_X = DESK.left + 28 + 10;

export function AppWindow({ active = "Payables", activeAmount = 1, children }: {
  active?: string;
  activeAmount?: number;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: WIN.x,
        top: WIN.y,
        width: WIN.w,
        height: WIN.h,
        display: "flex",
        background: tokens.background,
        boxShadow: "0 40px 120px oklch(0.15 0.05 264 / 0.45)",
        overflow: "hidden",
      }}
    >
      <Sidebar active={active} activeAmount={activeAmount} />
      <DeskFrame style={{ flex: 1, position: "relative" }}>{children}</DeskFrame>
    </div>
  );
}
