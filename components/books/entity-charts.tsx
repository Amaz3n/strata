"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BooksEntityChartEditor } from "./entity-chart-editor";
import {
  listBooksEntityChartsAction,
  readBooksEntityChartAction,
  reviewBooksEntityChartAction,
} from "@/app/(app)/books/actions";
type Page = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/legal-entities").listBooksEntityCharts
  >
>;
type Detail = Awaited<
  ReturnType<
    typeof import("@/lib/services/books/legal-entities").readBooksEntityChart
  >
>;
export function BooksEntityCharts({
  entityId,
  actorId,
  profileId,
  canPrepare,
  canReview,
  today,
}: {
  entityId: string;
  actorId: string;
  profileId: string | null;
  canPrepare: boolean;
  canReview: boolean;
  today: string;
}) {
  const [page, setPage] = useState<Page | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
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
  async function load() {
    setDetail(null);
    try {
      const r = await listBooksEntityChartsAction({ entityId });
      if (!r.success) {
        setPage(null);
        setError(r.error);
        return;
      }
      setPage(r.data);
      setError("");
    } catch {
      setPage(null);
      setError("Entity charts could not load. Refresh to retry.");
    }
  }
  useEffect(() => {
    let live = true;
    void listBooksEntityChartsAction({ entityId })
      .then((r) => {
        if (!live) return;
        if (r.success) {
          setPage(r.data);
          setError("");
        } else setError(r.error);
      })
      .catch(() => {
        if (live) setError("Entity charts could not load. Refresh to retry.");
      });
    return () => {
      live = false;
    };
  }, [entityId]);
  return (
    <section className="space-y-4" aria-label="Entity chart versions">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h4 className="text-base font-semibold">
            Entity chart and control accounts
          </h4>
          <p className="text-sm text-muted-foreground">
            Prepare a construction chart from a reviewed identity. Another
            member reviews its accounts and control mappings before approval.
            Entity ledger activation is still pending.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => start(load)}
        >
          Refresh charts
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {page && (
        <>
          <div className="space-y-2">
            {page.charts.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between border p-3"
              >
                <span>
                  Effective {c.effective_on} ·{" "}
                  {page.reviews.some((r) => r.chart_id === c.id)
                    ? "Reviewed"
                    : "Awaiting independent review"}
                </span>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      try {
                        const r = await readBooksEntityChartAction({
                          entityId,
                          chartId: c.id,
                        });
                        if (!r.success) {
                          setDetail(null);
                          setError(r.error);
                          return;
                        }
                        setDetail(r.data);
                        setError("");
                      } catch {
                        setDetail(null);
                        setError(
                          "Chart details could not load. Retry inspection.",
                        );
                      }
                    })
                  }
                >
                  Inspect accounts
                </Button>
              </div>
            ))}
          </div>
          {page.nextCursor && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  try {
                    const r = await listBooksEntityChartsAction({
                      entityId,
                      before: page.nextCursor!,
                    });
                    if (!r.success) {
                      setPage(null);
                      setDetail(null);
                      setError(r.error);
                      return;
                    }
                    setPage({
                      ...r.data,
                      charts: [...page.charts, ...r.data.charts],
                      reviews: [...page.reviews, ...r.data.reviews],
                    });
                  } catch {
                    setError("More chart versions could not load. Retry.");
                  }
                })
              }
            >
              Load more chart versions
            </Button>
          )}
          {canPrepare && profileId && (
            <BooksEntityChartEditor
              key={`editor:${entityId}:${actorId}`}
              entityId={entityId}
              today={today}
              onPrepared={load}
            />
          )}
        </>
      )}
      {detail && (
        <div className="space-y-3 border p-4">
          <h5 className="font-semibold">
            Chart effective {detail.chart.effective_on}
          </h5>
          <p className="text-sm whitespace-pre-wrap">
            {detail.chart.preparation_notes}
          </p>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left">Code</th>
                  <th className="text-left">Account</th>
                  <th className="text-left">Type / subtype</th>
                  <th className="text-left">Normal balance</th>
                </tr>
              </thead>
              <tbody>
                {detail.accounts.map((a) => {
                  const d = detail.definitions.find(
                    (d) => d.account_id === a.id,
                  )!;
                  return (
                    <tr key={a.id}>
                      <td>{a.code}</td>
                      <td>{d.name}</td>
                      <td>
                        {d.account_type} / {d.subtype}
                      </td>
                      <td>{d.normal_balance}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details>
            <summary className="cursor-pointer">
              Inspect control account mappings
            </summary>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              {detail.controls.map((c) => (
                <div key={c.id}>
                  <dt>{c.role}</dt>
                  <dd>
                    {detail.accounts.find((a) => a.id === c.account_id)?.code}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
          {detail.review ? (
            <p className="text-sm">
              Reviewed {detail.review.reviewed_at} ·{" "}
              {detail.review.review_notes}
            </p>
          ) : canReview && detail.chart.prepared_by !== actorId ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                const body = {
                  entityId,
                  chartId: detail.chart.id,
                  notes: String(new FormData(e.currentTarget).get("notes")),
                };
                start(async () => {
                  try {
                    const r = await reviewBooksEntityChartAction({
                      ...body,
                      reviewId: intent("review:" + detail.chart.id, body),
                    });
                    if (!r.success) {
                      toast.error(r.error);
                      return;
                    }
                    toast.success("Chart independently reviewed");
                    await load();
                  } catch {
                    toast.error(
                      "Review outcome is uncertain. Retry the unchanged form.",
                    );
                  }
                });
              }}
            >
              <Label htmlFor={`chart-review-${detail.chart.id}`}>
                Independent review notes
              </Label>
              <Textarea
                id={`chart-review-${detail.chart.id}`}
                name="notes"
                minLength={10}
                maxLength={2000}
                required
              />
              <Button disabled={pending}>Approve original chart</Button>
            </form>
          ) : (
            <p className="text-sm text-muted-foreground">
              A different member with entity review access must approve this
              chart.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
