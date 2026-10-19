"use client";

import Link from "next/link";
import { ArrowLeft, Ruler } from "lucide-react";
import type { MeasurementContext } from "@/lib/drawings/measurement-context";

export function MeasurementContextBar({
  context,
}: {
  context: MeasurementContext;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <Ruler className="size-3.5 shrink-0 text-primary" />
        <span className="truncate">
          Measuring for
          <span className="text-muted-foreground"> {context.label}</span>
        </span>
      </div>
      <Link
        className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
        href={context.returnHref}
      >
        <ArrowLeft className="size-3" />
        Return to{" "}
        {context.destination === "change_order"
          ? "change order"
          : context.destination === "estimate"
            ? "estimate"
            : "scope"}
      </Link>
    </div>
  );
}
