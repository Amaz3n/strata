"use client";

import type { ReactNode } from "react";

/**
 * Fields that are already live inputs, drawn as text.
 *
 * There is no edit mode to enter and no pencil to find: a value the viewer may
 * change reads as plain text until it is hovered, at which point it admits to
 * being a field. This is what keeps the record from looking like a form while
 * still being one.
 */
export const inlineInput =
  "h-9 border-transparent bg-transparent px-2 text-sm transition-colors hover:bg-muted/60 focus-visible:border-input focus-visible:bg-background focus-visible:ring-0";

export const inlineTrigger = `${inlineInput} w-full justify-between font-normal`;

/** The same affordance for things that aren't inputs — toggles, pickers. */
export const inlineCell =
  "h-9 -mx-2 px-2 text-left text-sm transition-colors hover:bg-muted/60";

/**
 * One band of the record. The name is an eyebrow above the content, so the
 * content gets the full width of the pane — cost lines, term grids and
 * timelines all start on the same left axis and have room to breathe. The
 * shared axis and the hairline between bands are what make a stack of
 * unrelated things read as one document instead of a pile of cards.
 */
export function RecordSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border/60 py-6 first:pt-0 last:border-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{label}</h3>
        {action}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** A label/value pair inside a section, aligned on its own inner axis. */
export function RecordRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-4 py-1.5">
      <span className="w-[120px] shrink-0 text-sm text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}
