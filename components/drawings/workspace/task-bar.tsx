"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The single strip that says what you are doing right now — measuring into an
 * item, setting the scale, reviewing a count, checking a revision. There is
 * only ever one, at the top of the sheet; anything that used to float in its
 * own box elsewhere says it here instead.
 */
export function TaskBar({
  tone = "default",
  children,
  className,
  label = "Current task",
}: {
  tone?: "default" | "warning" | "busy";
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      className={cn(
        "pointer-events-auto relative flex max-w-[calc(100%-1.5rem)] flex-wrap items-center gap-x-2.5 gap-y-1.5 overflow-hidden border bg-popover py-1.5 pl-3 pr-1.5 text-sm shadow-lg",
        tone === "warning" && "border-warning/60",
        className,
      )}
    >
      {tone === "busy" && (
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <span className="absolute inset-y-0 w-1/3 bg-primary animate-[drawing-shimmer_1.4s_ease-in-out_infinite]" />
        </span>
      )}
      {children}
    </div>
  );
}

export function TaskSwatch({ color }: { color: string }) {
  return <span className="size-2.5 shrink-0" style={{ backgroundColor: color }} aria-hidden />;
}

export function TaskTitle({ children }: { children: ReactNode }) {
  return <span className="whitespace-nowrap font-medium">{children}</span>;
}

export function TaskNote({ children }: { children: ReactNode }) {
  return <span className="min-w-0 text-xs text-muted-foreground">{children}</span>;
}
