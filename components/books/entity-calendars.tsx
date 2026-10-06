"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  listBooksEntityCalendarsAction,
  prepareBooksEntityCalendarAction,
  reviewBooksEntityCalendarAction,
} from "@/app/(app)/books/actions";
type Page = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/legal-entities").listBooksEntityCalendars
  >
>;
export function BooksEntityCalendars({
  entityId,
  profileId,
  actorId,
  canPrepare,
  canReview,
  today,
  profiles = [],
}: {
  entityId: string;
  profileId: string | null;
  actorId: string;
  canPrepare: boolean;
  canReview: boolean;
  today: string;
  profiles?: { id: string; label: string }[];
}) {
  const [page, setPage] = useState<Page | null>(null),
    [error, setError] = useState(""),
    [pending, start] = useTransition();
  const intents = useRef(new Map<string, { body: string; id: string }>());
  const intent = (key: string, body: unknown) => {
    const text = JSON.stringify(body),
      old = intents.current.get(key);
    if (old?.body === text) return old.id;
    const id = crypto.randomUUID();
    intents.current.set(key, { body: text, id });
    return id;
  };
  async function reload() {
    try {
      const r = await listBooksEntityCalendarsAction({ entityId });
      if (!r.success) {
        setPage(null);
        setError(r.error);
        return;
      }
      setPage(r.data);
      setError("");
    } catch {
      setPage(null);
      setError("Fiscal calendars could not load. Refresh to retry.");
    }
  }
  useEffect(() => {
    let live = true;
    void listBooksEntityCalendarsAction({ entityId })
      .then((r) => {
        if (!live) return;
        if (r.success) {
          setPage(r.data);
          setError("");
        } else setError(r.error);
      })
      .catch(() => {
        if (live)
          setError("Fiscal calendars could not load. Refresh to retry.");
      });
    return () => {
      live = false;
    };
  }, [entityId]);
  return (
    <section className="space-y-4" aria-label="Entity fiscal calendars">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-base font-semibold">Fiscal calendar</h4>
          <p className="text-sm text-muted-foreground">
            Prepare the dates from a reviewed legal identity, then have another
            member review all 12 periods. The year identifies the calendar year
            in which the fiscal year starts.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => start(reload)}
        >
          Refresh calendars
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!page && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading fiscal calendars…
        </p>
      )}
      {page && canPrepare && profileId && (
        <details className="border p-4">
          <summary className="cursor-pointer text-sm font-semibold">
            Prepare fiscal year
          </summary>
          <form
            className="mt-4 grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget),
                body = {
                  entityId,
                  profileId: String(form.get("profile") ?? profileId),
                  startsInYear: Number(form.get("year")),
                  notes: String(form.get("notes") ?? "").trim(),
                },
                calendarId = intent("prepare", body);
              start(async () => {
                try {
                  const r = await prepareBooksEntityCalendarAction({
                    ...body,
                    calendarId,
                  });
                  if (!r.success) {
                    toast.error(r.error);
                    return;
                  }
                  intents.current.delete("prepare");
                  toast.success(
                    "Fiscal calendar prepared for independent review",
                  );
                  await reload();
                } catch {
                  toast.error(
                    "Preparation could not be confirmed. Retry the unchanged form or refresh calendars.",
                  );
                }
              });
            }}
          >
            <fieldset className="grid gap-3" disabled={pending}>
              {profiles.length > 0 && (
                <>
                  <Label htmlFor="calendar-identity-profile">
                    Reviewed legal identity
                  </Label>
                  <select
                    id="calendar-identity-profile"
                    name="profile"
                    defaultValue={profileId}
                    className="w-full rounded-md border bg-background p-2 text-sm"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <Label htmlFor="calendar-start-year">Fiscal year starts in</Label>
              <Input
                id="calendar-start-year"
                name="year"
                type="number"
                required
                min={1900}
                max={9997}
                defaultValue={Number(today.slice(0, 4))}
              />
              <Label htmlFor="calendar-preparation-notes">
                Preparation evidence and notes
              </Label>
              <Textarea
                id="calendar-preparation-notes"
                name="notes"
                required
                minLength={10}
                maxLength={2000}
              />
              <Button type="submit">Prepare 12 fiscal periods</Button>
            </fieldset>
          </form>
        </details>
      )}
      {page && !profileId && (
        <p className="text-sm text-muted-foreground">
          Review the entity legal identity before preparing its fiscal calendar.
        </p>
      )}
      {page?.years.length === 0 && (
        <p className="border p-4 text-sm text-muted-foreground">
          No fiscal calendar has been prepared for this entity.
        </p>
      )}
      {page?.years.map((y) => {
        const review = page.reviews.find((r) => r.calendar_year_id === y.id),
          periods = page.periods
            .filter((p) => p.calendar_year_id === y.id)
            .sort((a, b) => a.period_number - b.period_number);
        return (
          <details key={y.id} className="border p-4">
            <summary className="cursor-pointer text-sm font-semibold tabular-nums">
              {y.starts_on} – {y.ends_on}
              <span className="ml-3 font-normal text-muted-foreground">
                {review ? "Independently reviewed" : "Awaiting review"}
              </span>
            </summary>
            <div className="mt-4 space-y-4">
              <p className="whitespace-pre-wrap text-sm">
                {y.preparation_notes}
              </p>
              <table className="w-full text-sm tabular-nums">
                <caption className="sr-only">Original fiscal periods</caption>
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2">Period</th>
                    <th>Starts</th>
                    <th>Ends</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.id} className="border-b">
                      <td className="py-2">{p.period_number}</td>
                      <td>{p.starts_on}</td>
                      <td>{p.ends_on}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {review ? (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  Review notes: {review.review_notes}
                </p>
              ) : canReview && y.prepared_by !== actorId ? (
                <form
                  className="grid gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const body = {
                        entityId,
                        calendarId: y.id,
                        notes: String(
                          new FormData(e.currentTarget).get("notes") ?? "",
                        ).trim(),
                      },
                      reviewId = intent(y.id, body);
                    start(async () => {
                      try {
                        const r = await reviewBooksEntityCalendarAction({
                          ...body,
                          reviewId,
                        });
                        if (!r.success) {
                          toast.error(r.error);
                          return;
                        }
                        intents.current.delete(y.id);
                        toast.success("Fiscal calendar independently reviewed");
                        await reload();
                      } catch {
                        toast.error(
                          "Review could not be confirmed. Retry the unchanged notes or refresh calendars.",
                        );
                      }
                    });
                  }}
                >
                  <Label htmlFor={`calendar-review-${y.id}`}>
                    Independent calendar review notes
                  </Label>
                  <Textarea
                    id={`calendar-review-${y.id}`}
                    name="notes"
                    required
                    minLength={10}
                    maxLength={2000}
                    disabled={pending}
                  />
                  <Button type="submit" disabled={pending}>
                    Review original fiscal periods
                  </Button>
                </form>
              ) : y.prepared_by === actorId ? (
                <p className="text-sm text-muted-foreground">
                  Another entity reviewer must review your calendar.
                </p>
              ) : null}
            </div>
          </details>
        );
      })}
      {page?.nextCursor && (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const r = await listBooksEntityCalendarsAction({
                  entityId,
                  before: page.nextCursor!,
                });
                if (!r.success) {
                  toast.error(r.error);
                  return;
                }
                setPage({
                  ...r.data,
                  years: [...page.years, ...r.data.years],
                  periods: [...page.periods, ...r.data.periods],
                  reviews: [...page.reviews, ...r.data.reviews],
                });
              } catch {
                toast.error(
                  "More fiscal calendars could not load. Retry this page.",
                );
              }
            })
          }
        >
          Load more calendars
        </Button>
      )}
      <p className="border-t pt-3 text-xs text-muted-foreground">
        Calendar review preserves dates. Entity ledger activation, posting and
        close are still pending.
      </p>
    </section>
  );
}
