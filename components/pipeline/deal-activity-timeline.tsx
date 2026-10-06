"use client";
import { format } from "date-fns";
import { MessageSquare, CircleDot } from "lucide-react";
import type { ProspectActivity } from "@/lib/services/prospects";
import { describeActivity } from "@/lib/sales/activity";
import { cn } from "@/lib/utils";

export function DealActivityTimeline({
  activity,
}: {
  activity: ProspectActivity[];
}) {
  if (!activity.length)
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        <MessageSquare className="mx-auto mb-3 size-6 opacity-50" />
        <p>No activity yet</p>
        <p className="mt-1 text-xs">
          Conversations and deal updates will appear here.
        </p>
      </div>
    );
  return (
    <ol>
      {activity.map((event, index) => {
        const logged = event.event_type === "prospect_contact_logged";
        const Icon = logged ? MessageSquare : CircleDot;
        return (
          <li key={event.id} className="flex gap-2.5">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center border",
                  logged
                    ? "border-primary/20 bg-primary/10 text-primary dark:text-primary"
                    : "border-border bg-muted/50 text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" />
              </span>
              {index < activity.length - 1 && (
                <span className="my-1 w-px flex-1 bg-border" />
              )}
            </div>
            <div className="min-w-0 flex-1 pb-4">
              <p className="text-sm font-medium">
                {logged
                  ? describeActivity(event).title
                  : formatActivityType(event.event_type)}
              </p>
              {renderActivityDetails(event)}
              <time
                dateTime={event.created_at}
                className="mt-1 block text-xs text-muted-foreground"
              >
                {format(new Date(event.created_at), "MMM d, yyyy 'at' h:mm a")}
              </time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function formatActivityType(eventType: string): string {
  if (eventType === "prospect_contact_logged") return "Contact recorded";
  const map: Record<string, string> = {
    prospect_created: "Prospect created",
    prospect_updated: "Prospect updated",
    prospect_status_changed: "Stage changed",
    prospect_deleted: "Prospect deleted",
    prospect_contact_added: "Contact added",
    prospect_contact_updated: "Contact updated",
    prospect_follow_up_set: "Follow-up scheduled",
    prospect_follow_up_cleared: "Follow-up cleared",
    prospect_estimate_created: "Estimate created",
    estimate_sent: "Estimate sent",
    estimate_viewed: "Estimate opened by client",
    estimate_client_signed: "Estimate signed by client",
    estimate_changes_requested: "Changes requested by client",
    estimate_rejected: "Estimate rejected by client",
    estimate_executed: "Estimate executed (signed)",
    estimate_comment_added: "New estimate message",
  };
  return (
    map[eventType] ??
    eventType.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

function renderActivityDetails(event: ProspectActivity): React.ReactNode {
  const p = event.payload as any;
  if (!p) return null;

  if (event.event_type === "prospect_contact_logged") {
    const detail = describeActivity(event);
    return (
      <span className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
        {detail.note}
      </span>
    );
  }
  switch (event.event_type) {
    case "prospect_follow_up_set":
      return typeof p.next_follow_up_at === "string" &&
        !Number.isNaN(Date.parse(p.next_follow_up_at)) ? (
        <span className="text-sm text-muted-foreground">
          {format(new Date(p.next_follow_up_at), "MMM d, yyyy 'at' h:mm a")}
        </span>
      ) : null;

    case "prospect_estimate_created":
      return p.estimate_title ? (
        <span className="text-xs text-muted-foreground">
          Created estimate{" "}
          <span className="font-medium text-foreground">
            "{p.estimate_title}"
          </span>
        </span>
      ) : null;
    case "estimate_sent":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Sent estimate{" "}
          <span className="font-medium text-foreground">"{p.title}"</span>
          {p.recipient_email ? ` to ${p.recipient_email}` : ""}
        </span>
      ) : null;
    case "estimate_viewed":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Client viewed estimate{" "}
          <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null;
    case "estimate_client_signed":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Signed by{" "}
          <span className="font-medium text-foreground">
            {p.by || "Client"}
          </span>{" "}
          for estimate{" "}
          <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null;
    case "estimate_changes_requested":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Changes requested by{" "}
          <span className="font-medium text-foreground">
            {p.by || "Client"}
          </span>{" "}
          on estimate{" "}
          <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null;
    case "estimate_rejected":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Rejected by{" "}
          <span className="font-medium text-foreground">
            {p.by || "Client"}
          </span>{" "}
          on estimate{" "}
          <span className="font-medium text-foreground">"{p.title}"</span>
        </span>
      ) : null;
    case "estimate_executed":
      return p.title ? (
        <span className="text-xs text-muted-foreground">
          Countersigned by{" "}
          <span className="font-medium text-foreground">
            {p.signer_name || "Builder"}
          </span>{" "}
          — estimate{" "}
          <span className="font-medium text-foreground">"{p.title}"</span> is
          executed
        </span>
      ) : null;
    case "estimate_comment_added":
      return (
        <span className="text-xs text-muted-foreground">
          Comment posted by{" "}
          <span className="font-medium text-foreground">
            {p.author_type === "client" ? "Client" : "Builder"}
          </span>
        </span>
      );
    case "prospect_status_changed":
      return p.new_status || p.to ? (
        <span className="text-xs text-muted-foreground">
          Moved from{" "}
          <span className="capitalize">
            {p.old_status || p.from || "unknown"}
          </span>{" "}
          to{" "}
          <span className="font-medium text-foreground capitalize">
            {p.new_status || p.to}
          </span>
        </span>
      ) : null;
    default:
      return null;
  }
}
