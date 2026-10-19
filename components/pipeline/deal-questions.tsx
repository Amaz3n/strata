"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { answerClientQuestionAction, askClientQuestionAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import { cn } from "@/lib/utils";

export type DealQuestion = {
  id: string;
  title: string;
  status: "open" | "resolved" | "waived";
  resolution: string;
  version: number;
};

/**
 * What the client must decide before they sign. Questions print in the client's
 * proposal, where the client answers them; the proposal cannot be signed while
 * one is open, because a signed number cannot rest on an unanswered question.
 */
export function DealQuestions({
  dealId,
  clientName,
  questions,
  editable,
}: {
  dealId: string;
  clientName: string;
  questions: DealQuestion[];
  editable: boolean;
}) {
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [answering, setAnswering] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [pending, startTransition] = useTransition();
  const who = clientName.split(" ")[0] || "the client";

  function run(work: () => Promise<void>) {
    startTransition(async () => {
      try {
        await work();
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to save the question");
      }
    });
  }

  return (
    <section id="deal-questions" aria-labelledby="deal-questions-heading" className="scroll-mt-4">
      <div className="flex flex-wrap items-baseline gap-x-3 pb-2">
        <h2 id="deal-questions-heading" className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Questions for {who}
        </h2>
        <p className="text-xs text-muted-foreground">
          They appear in {who}&apos;s proposal, and {who} answers them there before signing.
        </p>
      </div>
      <ul className="divide-y border bg-card">
        {!questions.length && (
          <li className="px-4 py-3 text-sm text-muted-foreground">
            Nothing to ask yet. Add anything {who} must decide before signing.
          </li>
        )}
        {questions.map((item) => {
          const open = item.status === "open";
          return (
            <li key={item.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 px-4 py-2.5">
              <span
                aria-hidden
                className={cn("mt-1 size-3.5 border", open ? "border-muted-foreground/50" : "border-success bg-success")}
              />
              <div className="min-w-0">
                <p className="text-sm">{item.title}</p>
                {!open && item.resolution && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {who}: {item.resolution}
                  </p>
                )}
                {answering === item.id && (
                  <form
                    className="mt-2 flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(async () => {
                        unwrapAction(
                          await answerClientQuestionAction(dealId, { id: item.id, version: item.version, answer }),
                        );
                        setAnswering(null);
                        setAnswer("");
                      });
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label={`${who}'s answer`}
                      placeholder={`What did ${who} say?`}
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                    />
                    <Button type="submit" size="sm" disabled={pending || answer.trim().length < 3}>
                      Save
                    </Button>
                  </form>
                )}
              </div>
              {open ? (
                editable && answering !== item.id ? (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setAnswering(item.id)}>
                    Record answer
                  </Button>
                ) : (
                  <span className="text-xs text-warning">Waiting</span>
                )
              ) : (
                <span className="text-xs text-success">Answered</span>
              )}
            </li>
          );
        })}
        {editable && (
          <li>
            <form
              className="flex items-center gap-2 px-3 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  unwrapAction(await askClientQuestionAction(dealId, question));
                  setQuestion("");
                });
              }}
            >
              <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Input
                aria-label={`Ask ${who} a question`}
                className="border-0 bg-transparent shadow-none focus-visible:ring-0"
                placeholder="Ask something, e.g. Gas or electric range?"
                value={question}
                disabled={pending}
                onChange={(event) => setQuestion(event.target.value)}
              />
              <Button type="submit" variant="ghost" size="sm" disabled={pending || question.trim().length < 3}>
                Ask
              </Button>
            </form>
          </li>
        )}
      </ul>
    </section>
  );
}
