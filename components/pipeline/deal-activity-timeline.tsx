"use client";

import { format } from "date-fns";
import { CalendarCheck, CalendarPlus, Circle, Eye, FileText, Mail, MessageSquare, Phone, Users, type LucideIcon } from "@/components/icons";
import { describeActivity, type ActivityKind } from "@/lib/sales/activity";
import type { ProspectActivity } from "@/lib/services/prospects";
import { cn } from "@/lib/utils";

type Who = "you" | "client" | "system";

export const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  call: Phone,
  visit: Users,
  text: MessageSquare,
  email: Mail,
  note: FileText,
};

const WHO_STYLE: Record<Who, string> = {
  you: "border-primary/30 bg-primary/5 text-primary",
  client: "border-chart-5/30 bg-chart-5/5 text-chart-5",
  system: "border-border bg-card text-muted-foreground",
};

const CLIENT_EVENTS = new Set([
  "estimate_viewed",
  "estimate_client_signed",
  "estimate_changes_requested",
  "estimate_rejected",
]);

const text = (payload: ProspectActivity["payload"], key: string) => {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value : null;
};

/** One line per event, in words, with who acted: a person logged it, the client did it, or Arc recorded it. */
function describe(event: ProspectActivity): { title: string; note: string | null; who: Who; icon: LucideIcon } {
  const payload = event.payload;
  const title = text(payload, "title");
  const doc = title ? ` “${title}”` : "";
  switch (event.event_type) {
    case "prospect_contact_logged": {
      const logged = describeActivity(event);
      const at = text(payload, "occurred_at");
      return {
        title: `${logged.title} logged${at ? ` for ${format(new Date(at), "EEE, MMM d")}` : ""}`,
        note: logged.note,
        who: "you",
        icon: logged.kind ? KIND_ICON[logged.kind] : MessageSquare,
      };
    }
    case "prospect_created":
      return { title: "Deal created", note: null, who: "system", icon: Circle };
    case "prospect_follow_up_set": {
      const at = text(payload, "next_follow_up_at");
      return {
        title: at && !Number.isNaN(Date.parse(at)) ? `Follow-up set for ${format(new Date(at), "EEE, MMM d")}` : "Follow-up set",
        note: text(payload, "note"),
        who: "you",
        icon: CalendarPlus,
      };
    }
    case "prospect_follow_up_cleared":
      return text(payload, "outcome") === "done"
        ? { title: "Follow-up done", note: null, who: "you", icon: CalendarCheck }
        : { title: "Follow-up cleared", note: null, who: "system", icon: Circle };
    case "deal_price_started":
      return { title: `Price started from ${text(payload, "label") ?? "a blank sheet"}`, note: null, who: "system", icon: Circle };
    case "precon_decision_updated":
      return {
        title: text(payload, "status") === "open" ? "Question for the client" : "Client question answered",
        note: text(payload, "title"),
        who: "system",
        icon: Circle,
      };
    case "estimate_sent":
      return {
        title: `Sent${doc}${text(payload, "recipient_email") ? ` to ${text(payload, "recipient_email")}` : ""}`,
        note: null,
        who: "system",
        icon: Mail,
      };
    case "estimate_viewed":
      return { title: `Client opened${doc}`, note: null, who: "client", icon: Eye };
    case "estimate_client_signed":
      return { title: `${text(payload, "by") ?? "Client"} signed${doc}`, note: null, who: "client", icon: FileText };
    case "estimate_changes_requested":
      return { title: `${text(payload, "by") ?? "Client"} asked for changes${doc}`, note: text(payload, "note"), who: "client", icon: FileText };
    case "estimate_rejected":
      return { title: `${text(payload, "by") ?? "Client"} declined${doc}`, note: text(payload, "note"), who: "client", icon: FileText };
    case "estimate_executed":
      return { title: `Countersigned${doc}`, note: null, who: "system", icon: FileText };
    case "estimate_comment_added":
      return {
        title: text(payload, "author_type") === "client" ? "Client left a message" : "Message posted",
        note: null,
        who: text(payload, "author_type") === "client" ? "client" : "system",
        icon: MessageSquare,
      };
    default:
      return {
        title: event.event_type.replace(/^prospect_/, "").replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase()),
        note: null,
        who: CLIENT_EVENTS.has(event.event_type) ? "client" : "system",
        icon: Circle,
      };
  }
}

const dayLabel = (date: Date, today: Date) => {
  const days = Math.round(
    (new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86_400_000,
  );
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return format(date, date.getFullYear() === today.getFullYear() ? "EEE, MMM d" : "MMM d, yyyy");
};

/** What happened on the deal, newest first, grouped by day. */
export function DealActivityTimeline({ activity, today }: { activity: ProspectActivity[]; today: Date }) {
  if (!activity.length)
    return (
      <div className="border border-dashed px-6 py-10 text-center">
        <p className="text-sm font-medium">Nothing has happened yet</p>
        <p className="mt-1 text-sm text-muted-foreground">Log the first call above. Sends, opens and answers land here too.</p>
      </div>
    );
  const days: Array<{ label: string; events: ProspectActivity[] }> = [];
  for (const event of activity) {
    const label = dayLabel(new Date(event.created_at), today);
    const day = days.at(-1);
    if (day?.label === label) day.events.push(event);
    else days.push({ label, events: [event] });
  }
  return (
    <div className="space-y-5">
      {days.map((day) => (
        <section key={day.label} aria-label={day.label}>
          <h3 className="pb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{day.label}</h3>
          <ol>
            {day.events.map((event) => {
              const item = describe(event);
              const Icon = item.icon;
              return (
                <li key={event.id} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-start gap-3 py-2.5">
                  <span className={cn("grid size-7 place-items-center border", WHO_STYLE[item.who])}>
                    <Icon className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm">{item.title}</p>
                    {item.note && (
                      <p className="mt-1.5 whitespace-pre-line break-words border-l-2 bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                        {item.note}
                      </p>
                    )}
                  </div>
                  <time dateTime={event.created_at} className="pt-0.5 text-xs tabular-nums text-muted-foreground">
                    {format(new Date(event.created_at), "h:mm a")}
                  </time>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
