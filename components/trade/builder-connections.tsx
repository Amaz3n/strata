"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { openBuilderConnectionAction } from "@/app/(app)/trade/connections/actions";
import type { ExternalPortalWorkspaceItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { formatLocalDate } from "@/lib/utils";

export function BuilderConnections({
  items,
}: {
  items: Array<
    Pick<
      ExternalPortalWorkspaceItem,
      "id" | "kind" | "org_name" | "project_name" | "subtitle" | "due_at"
    >
  >;
}) {
  const [pending, startTransition] = useTransition();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-6 desk-rise">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          Builder connections
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Projects and bids shared with your email across builders on Arc. Open
          a builder’s workspace to respond to bids, submit invoices, share
          compliance documents, and complete assigned work.
        </p>
      </div>
      <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
        Your company’s jobs and private costs stay separate. Builder submissions
        are managed in the shared workspace; they are not automatically copied
        to your company’s billing.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {items.length ? (
        <div className="divide-y border-y">
          {items.slice(0, 200).map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-4 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">
                  {item.org_name} ·{" "}
                  {item.kind === "bid" ? "Bid invitation" : "Shared project"}
                </p>
                <p className="mt-1 truncate text-sm font-medium">
                  {item.project_name}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.subtitle}
                  {item.due_at
                    ? ` · Due ${formatLocalDate(item.due_at, "MMM d")}`
                    : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setOpening(item.id);
                  startTransition(async () => {
                    const result = await openBuilderConnectionAction(item.id);
                    if (!result.success) {
                      setError(result.error);
                      setOpening(null);
                      return;
                    }
                    window.location.assign(result.data.href);
                  });
                }}
              >
                {pending && opening === item.id ? "Opening…" : "Open workspace"}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <section className="max-w-xl py-8">
          <h2 className="text-base font-semibold">
            Your builder invitations will appear here
          </h2>
          <ol className="mt-4 list-decimal space-y-3 pl-5 text-sm leading-6 text-muted-foreground">
            <li>Ask the builder to invite the email you use for Arc Trade.</li>
            <li>
              Open their invitation and claim your portal account. Verify that
              email when prompted.
            </li>
            <li>Return here to access your shared projects and bids.</li>
          </ol>
          <p className="mt-4 text-sm text-muted-foreground">
            You can start your own jobs while you wait for an invitation.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link href="/">Back to Today</Link>
          </Button>
        </section>
      )}
      {items.length > 200 && (
        <p className="text-xs text-muted-foreground">
          Showing the first 200 of {items.length} invitations. Existing
          invitation links remain available.
        </p>
      )}
    </div>
  );
}
