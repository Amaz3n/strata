"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarCheck, CalendarClock, CalendarDays, CalendarPlus, Check, Loader2, MoreHorizontal, X } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { formatDateValue, parseDateValue } from "@/components/ui/date-field";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { OptimisticLink } from "@/lib/navigation/optimistic-pathname";
import {
  closeDealFollowUpAction,
  logDealActivityAction,
  saveDealNotesAction,
  scheduleDealFollowUpAction,
} from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction, type ActionResult } from "@/lib/action-result";
import { budgetBand } from "@/lib/precon/format";
import { ACTIVITY_KINDS, ACTIVITY_LABELS, type ActivityKind } from "@/lib/sales/activity";
import type { ProspectActivity } from "@/lib/services/prospects";
import type { DealFollowUpInput } from "@/lib/validation/deals";
import { cn } from "@/lib/utils";
import { DealActivityTimeline, KIND_ICON } from "./deal-activity-timeline";
import { useDealRoom } from "./deal-room";
import { daysUntil, followUpChoices, followUpWhen, localDay, shortDay } from "./follow-up";

type Mode = ActivityKind | "follow_up";

const SUBMIT: Record<Mode, string> = {
  call: "Log call",
  visit: "Log visit",
  text: "Log text",
  email: "Log email",
  note: "Save note",
  follow_up: "Schedule follow-up",
};

/** What the open follow-up is for: the note on the event that set it, if it is still the one standing. */
function openFollowUpNote(activity: ProspectActivity[], followUpAt: string | null): string | null {
  if (!followUpAt) return null;
  const latest = activity.find(
    (event) => event.event_type === "prospect_follow_up_set" || event.event_type === "prospect_follow_up_cleared",
  );
  if (latest?.event_type !== "prospect_follow_up_set") return null;
  const at = latest.payload?.next_follow_up_at;
  const note = latest.payload?.note;
  if (typeof at !== "string" || new Date(at).getTime() !== new Date(followUpAt).getTime()) return null;
  return typeof note === "string" && note.trim() ? note : null;
}

/** The deal at a glance: what happens next, what happened, and what we know about the client and the job. */
export function DealOverview({ activity, truncated }: { activity: ProspectActivity[]; truncated: boolean }) {
  const room = useDealRoom();
  const logIt = useRef<(() => void) | null>(null);
  const followUpNote = openFollowUpNote(activity, room.deal.followUpAt);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="min-w-0 space-y-4">
        {room.deal.followUpAt && (
          <DealFollowUp at={room.deal.followUpAt} note={followUpNote} onLog={() => logIt.current?.()} />
        )}
        {/* Remounts when the follow-up changes, so whether a touch closes it starts from the new one. */}
        {room.editable && <DealComposer key={room.deal.followUpAt ?? "none"} logIt={logIt} />}
        <div className="pt-2">
          <DealActivityTimeline activity={activity} today={new Date(room.now)} />
          {truncated && <p className="mt-3 text-xs text-muted-foreground">Showing the latest {activity.length} events.</p>}
        </div>
      </div>
      <aside className="space-y-4" aria-label="About the deal">
        <DealDetails />
        <DealNotes />
      </aside>
    </div>
  );
}

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border bg-card">
      <div className="flex min-h-11 items-center justify-between gap-2 border-b px-4 py-2">
        <h2 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Runs a deal mutation, refreshes the room, and reports a failure. */
function useDealMutation() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function mutate(work: () => Promise<ActionResult<unknown>>, done?: () => void) {
    startTransition(async () => {
      try {
        unwrapAction(await work());
        done?.();
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to save");
      }
    });
  }
  return { pending, mutate };
}

/** The open follow-up, above everything else on the deal: when, what for, and the ways to close it. */
function DealFollowUp({ at, note, onLog }: { at: string; note: string | null; onLog: () => void }) {
  const { deal, editable, now } = useDealRoom();
  const today = new Date(now);
  const when = followUpWhen(at, today);
  const days = daysUntil(at, today);
  const { pending, mutate } = useDealMutation();
  const [rescheduling, setRescheduling] = useState(false);
  const who = deal.client.name.split(" ")[0] || "the client";
  return (
    <section
      aria-label="Next follow-up"
      className={cn(
        "relative flex flex-wrap items-center gap-x-4 gap-y-3 border bg-card py-3 pl-4 pr-3 shadow-xs",
        days < 0 ? "border-age-2/40" : days === 0 ? "border-warning/40" : "",
      )}
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center",
          days < 0 ? "bg-age-2/10 text-age-2" : days === 0 ? "bg-warning/12 text-warning" : "bg-primary/10 text-primary",
        )}
      >
        <CalendarClock className="size-4" />
      </span>
      <div className="min-w-0 flex-[1_1_14rem]">
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Follow-up · <span className={when.tone}>{when.label}</span>
        </p>
        <p className="truncate text-sm font-medium">{note ?? `Follow up with ${who}`}</p>
        <p className="text-xs tabular-nums text-muted-foreground">{shortDay(at, today)}</p>
      </div>
      {editable && (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant={days <= 0 ? "default" : "outline"} className="h-8" disabled={pending} onClick={onLog}>
            Log it
          </Button>
          <Popover open={rescheduling} onOpenChange={setRescheduling}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="h-8" disabled={pending}>
                Reschedule
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-0">
              <FollowUpChoices
                value={{ on: localDay(new Date(at)), note: note ?? "" }}
                withNote
                submitLabel="Reschedule"
                onSubmit={(value) =>
                  mutate(() => scheduleDealFollowUpAction(deal.id, value), () => setRescheduling(false))
                }
              />
            </PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-8" aria-label="More follow-up actions" disabled={pending}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => mutate(() => closeDealFollowUpAction(deal.id, "done"))}>
                <CalendarCheck className="size-4" />
                Mark done without logging
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => mutate(() => closeDealFollowUpAction(deal.id, "cleared"))}>
                <X className="size-4" />
                Clear the follow-up
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </section>
  );
}

/**
 * Quick days for a follow-up, a date for anything else, and (when it stands
 * alone) what it is for. In the composer the text box is the note.
 */
function FollowUpChoices({
  value,
  withNote,
  submitLabel,
  onSubmit,
}: {
  value: DealFollowUpInput | null;
  withNote: boolean;
  submitLabel: string;
  onSubmit: (value: DealFollowUpInput) => void;
}) {
  const { now } = useDealRoom();
  const today = new Date(now);
  const [on, setOn] = useState(value?.on ?? "");
  const [note, setNote] = useState(value?.note ?? "");
  return (
    <div className="divide-y">
      <div className="grid gap-0.5 p-1.5">
        {followUpChoices(today).map((choice) => (
          <button
            key={choice.label}
            type="button"
            onClick={() => (withNote ? setOn(choice.on) : onSubmit({ on: choice.on, note }))}
            className={cn(
              "flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-muted",
              on === choice.on && "bg-primary/10 text-primary",
            )}
          >
            {choice.label}
            <span className="text-xs tabular-nums text-muted-foreground">{shortDay(choice.on, today)}</span>
          </button>
        ))}
      </div>
      <div className="space-y-2 p-3">
        <Calendar
          mode="single"
          className="mx-auto p-0"
          selected={parseDateValue(on)}
          defaultMonth={parseDateValue(on) ?? today}
          disabled={{ before: today }}
          onSelect={(date) => {
            if (!date) return;
            const picked = formatDateValue(date);
            if (withNote) setOn(picked);
            else onSubmit({ on: picked, note });
          }}
        />
        {withNote && (
          <Input
            aria-label="What the follow-up is for"
            placeholder="What is it for? (optional)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="h-8 text-sm"
          />
        )}
        {withNote && (
          <Button size="sm" className="h-8 w-full" disabled={!on} onClick={() => onSubmit({ on, note: note.trim() })}>
            {submitLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

const pill =
  "inline-flex h-8 items-center gap-1.5 bg-muted/50 px-2.5 text-[13px] font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Logging what happened, in the shape of the app's composers (new task, new
 * issue): the words first, metadata as pills under them, the button in a
 * footer. A touch can close the open follow-up and leave the next one in the
 * same entry, because that is how the call went.
 */
function DealComposer({ logIt }: { logIt: RefObject<(() => void) | null> }) {
  const { deal, now } = useDealRoom();
  const today = new Date(now);
  const todayKey = localDay(today);
  const open = deal.followUpAt;
  const openDue = open ? daysUntil(open, today) <= 0 : false;
  const [mode, setMode] = useState<Mode>("call");
  const [text, setText] = useState("");
  const [day, setDay] = useState(todayKey);
  const [dayOpen, setDayOpen] = useState(false);
  const [next, setNext] = useState<DealFollowUpInput | null>(null);
  const [nextOpen, setNextOpen] = useState(false);
  const [complete, setComplete] = useState(openDue);
  const [scheduleOn, setScheduleOn] = useState(followUpChoices(today)[1].on);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const { pending, mutate } = useDealMutation();
  const who = deal.client.name.split(" ")[0] || "the client";
  const touch = mode !== "follow_up";

  // "Log it" on the follow-up card: a touch that closes it, ready to type.
  useEffect(() => {
    logIt.current = () => {
      setMode((current) => (current === "follow_up" || current === "note" ? "call" : current));
      setComplete(true);
      textarea.current?.focus();
    };
    return () => {
      logIt.current = null;
    };
  }, [logIt]);

  const placeholder: Record<Mode, string> = {
    call: `What did ${who} say?`,
    visit: "What did you see, and what was said?",
    text: "What was said?",
    email: "What was sent or received?",
    note: "Anything worth remembering",
    follow_up: `What do you need to follow up with ${who} about?`,
  };
  const canSubmit = !pending && (mode !== "note" || text.trim().length > 0);

  function reset() {
    setText("");
    setDay(todayKey);
    setNext(null);
  }

  function submit() {
    if (!canSubmit) return;
    if (!touch) {
      mutate(() => scheduleDealFollowUpAction(deal.id, { on: scheduleOn, note: text.trim() }), () => {
        reset();
        setMode("call");
        toast.success(`Follow-up set for ${shortDay(scheduleOn, today)}`);
      });
      return;
    }
    mutate(
      () =>
        logDealActivityAction(deal.id, {
          kind: mode,
          note: text.trim(),
          occurred_on: day === todayKey ? null : day,
          complete_follow_up: Boolean(open) && complete,
          follow_up: next,
        }),
      reset,
    );
  }

  return (
    <form
      className="border bg-card shadow-xs transition-colors duration-150 focus-within:border-primary/40"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1 px-3 pt-3" role="group" aria-label="What to log">
        {ACTIVITY_KINDS.map((value) => {
          const Icon = KIND_ICON[value];
          return (
            <ModeButton key={value} active={mode === value} onClick={() => setMode(value)}>
              <Icon className="size-3.5" />
              {ACTIVITY_LABELS[value]}
            </ModeButton>
          );
        })}
        <span aria-hidden className="mx-1 h-4 w-px bg-border" />
        <ModeButton active={mode === "follow_up"} onClick={() => setMode("follow_up")}>
          <CalendarPlus className="size-3.5" />
          Follow-up
        </ModeButton>
      </div>

      <Textarea
        ref={textarea}
        aria-label={touch ? "What happened" : "What the follow-up is for"}
        placeholder={placeholder[mode]}
        value={text}
        onChange={(event) => setText(event.target.value)}
        className="field-sizing-content min-h-20 resize-none border-0 bg-transparent px-4 py-3 text-[15px] leading-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />

      <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
        {touch ? (
          <>
            <Popover open={dayOpen} onOpenChange={setDayOpen}>
              <PopoverTrigger asChild>
                <button type="button" className={pill} aria-label={`When it happened: ${day === todayKey ? "today" : shortDay(day, today)}`}>
                  <CalendarDays className="size-3.5 text-muted-foreground" />
                  {day === todayKey ? "Today" : shortDay(day, today)}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-2">
                <Calendar
                  mode="single"
                  selected={parseDateValue(day)}
                  defaultMonth={parseDateValue(day)}
                  disabled={{ after: today }}
                  onSelect={(date) => {
                    setDay(date ? formatDateValue(date) : todayKey);
                    setDayOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            {open && (
              <button
                type="button"
                aria-pressed={complete}
                onClick={() => setComplete((value) => !value)}
                className={cn(pill, complete && "bg-success/12 text-success hover:bg-success/15")}
              >
                {complete ? <Check className="size-3.5" /> : <CalendarCheck className="size-3.5 text-muted-foreground" />}
                {complete ? "Closes" : "Close"} the follow-up · {shortDay(open, today)}
              </button>
            )}
            <Popover open={nextOpen} onOpenChange={setNextOpen}>
              <PopoverTrigger asChild>
                <button type="button" className={cn(pill, next && "bg-primary/10 text-primary hover:bg-primary/15")}>
                  <CalendarPlus className={cn("size-3.5", !next && "text-muted-foreground")} />
                  {next ? `Next follow-up ${shortDay(next.on, today)}` : "Next follow-up"}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-0">
                <FollowUpChoices
                  value={next}
                  withNote
                  submitLabel="Set"
                  onSubmit={(value) => {
                    setNext(value);
                    setNextOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            {next && (
              <Button type="button" size="icon" variant="ghost" className="size-7" aria-label="Remove the next follow-up" onClick={() => setNext(null)}>
                <X className="size-3.5" />
              </Button>
            )}
          </>
        ) : (
          <>
            <Popover open={scheduleOpen} onOpenChange={setScheduleOpen}>
              <PopoverTrigger asChild>
                <button type="button" className={cn(pill, "bg-primary/10 text-primary hover:bg-primary/15")}>
                  <CalendarClock className="size-3.5" />
                  {shortDay(scheduleOn, today)}
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72 p-0">
                <FollowUpChoices
                  value={{ on: scheduleOn, note: "" }}
                  withNote={false}
                  submitLabel="Use this day"
                  onSubmit={(value) => {
                    setScheduleOn(value.on);
                    setScheduleOpen(false);
                  }}
                />
              </PopoverContent>
            </Popover>
            {open && (
              <span className="text-xs text-muted-foreground">Replaces the follow-up on {shortDay(open, today)}.</span>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-3 py-2">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {touch && next
            ? `Then follow up ${shortDay(next.on, today)}${next.note ? `: ${next.note}` : ""}`
            : touch && day !== todayKey
              ? `Logged for ${shortDay(day, today)}`
              : "It lands in the timeline below."}
        </p>
        <Button type="submit" size="sm" disabled={!canSubmit} className="gap-2">
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {SUBMIT[mode]}
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">⌘↵</Kbd>
        </Button>
      </div>
    </form>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 px-2.5 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground",
        active && "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

/** What the deal is: who, where, how much they have in mind, and how they found you. */
function DealDetails() {
  const room = useDealRoom();
  const { deal, editable } = room;
  const client = deal.client;
  const rows: Array<[string, ReactNode]> = [
    [
      "Client",
      client.name ? (
        client.directoryId ? (
          <OptimisticLink
            href={`/directory/${client.directoryId}`}
            prefetchOnIntent
            className="font-medium underline-offset-4 transition-colors duration-150 hover:text-primary hover:underline"
          >
            {client.name}
          </OptimisticLink>
        ) : (
          client.name
        )
      ) : (
        "—"
      ),
    ],
    [
      "Email",
      client.email ? (
        <a href={`mailto:${client.email}`} className="underline-offset-4 hover:text-primary hover:underline">
          {client.email}
        </a>
      ) : (
        "—"
      ),
    ],
    [
      "Phone",
      client.phone ? (
        <a href={`tel:${client.phone}`} className="tabular-nums underline-offset-4 hover:text-primary hover:underline">
          {client.phone}
        </a>
      ) : (
        "—"
      ),
    ],
    ["Site", client.address || "—"],
    ["Budget", budgetBand(deal.budget) ?? deal.budget ?? "—"],
    ["Timeframe", deal.timeframe ?? "—"],
    ["Found you", deal.source ?? "—"],
  ];
  return (
    <Panel
      title="Details"
      action={
        editable && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => room.openPanel("client")}>
            Edit
          </Button>
        )
      }
    >
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] px-4 text-[13px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents [&:last-child>*]:border-b-0">
            <dt className="border-b py-2 text-muted-foreground">{label}</dt>
            <dd className="break-words border-b py-2">{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

const savedAt = (at: Date) => at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/** Free notes about the deal. They are notes, never pricing lines; they grow with what is written. */
function DealNotes() {
  const { deal, editable } = useDealRoom();
  const [notes, setNotes] = useState(deal.notes);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "error" } | { kind: "saved"; at: Date }>({ kind: "idle" });
  const saved = useRef(deal.notes);
  useEffect(() => {
    if (!editable || notes === saved.current) return;
    const timer = setTimeout(() => {
      setStatus({ kind: "saving" });
      void saveDealNotesAction(deal.id, notes).then((result) => {
        if (result.success) {
          saved.current = notes;
          setStatus({ kind: "saved", at: new Date() });
        } else setStatus({ kind: "error" });
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [notes, deal.id, editable]);
  return (
    <Panel
      title="Notes"
      action={
        <span role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-muted-foreground">
          {status.kind === "saving" && (
            <>
              <Loader2 className="size-3 animate-spin" />
              Saving
            </>
          )}
          {status.kind === "saved" && (
            <>
              <Check className="size-3 text-success" />
              Saved {savedAt(status.at)}
            </>
          )}
          {status.kind === "error" && <span className="text-destructive">Not saved. Keep typing to retry.</span>}
        </span>
      }
    >
      <div className="p-3">
        <Textarea
          aria-label="Notes"
          className="field-sizing-content min-h-32 resize-none border-dashed bg-transparent px-3 py-2.5 text-sm leading-6 shadow-none transition-colors duration-150 hover:border-muted-foreground/40 focus-visible:border-solid focus-visible:border-primary/50 focus-visible:ring-0 disabled:border-transparent dark:bg-transparent"
          disabled={!editable}
          placeholder={"Write a note…\nWho decides, what they care about, what to avoid."}
          value={notes}
          onChange={(event) => {
            setStatus({ kind: "idle" });
            setNotes(event.target.value);
          }}
        />
      </div>
    </Panel>
  );
}
