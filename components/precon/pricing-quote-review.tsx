"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { listAttachmentsAction } from "@/app/(app)/documents/actions";
import type { BidSubmission } from "@/lib/services/bids";
import {
  Attachment,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";

type QuoteFile = { id: string; name: string; url?: string };
export function PricingQuoteReview({
  submission,
}: {
  submission: BidSubmission;
}) {
  const [files, setFiles] = useState<QuoteFile[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    listAttachmentsAction("bid_submission", submission.id)
      .then((links) => {
        if (!active) return;
        setFiles(
          links.map((link) => {
            const record = link as unknown as {
              id: string;
              file?: { file_name?: string; download_url?: string };
            };
            return {
              id: record.id,
              name: record.file?.file_name ?? "Attachment",
              url: record.file?.download_url,
            };
          }),
        );
        setError(false);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [submission.id, attempt]);
  const schedule = [
    submission.valid_until
      ? `Valid through ${submission.valid_until.slice(0, 10)}`
      : "",
    submission.lead_time_days != null
      ? `${submission.lead_time_days} day lead time`
      : "",
    submission.duration_days != null
      ? `${submission.duration_days} day duration`
      : "",
    submission.start_available_on
      ? `Available ${submission.start_available_on.slice(0, 10)}`
      : "",
  ].filter(Boolean);
  if (
    !schedule.length &&
    !submission.clarifications &&
    !submission.notes &&
    files?.length === 0 &&
    !error
  )
    return null;
  return (
    <div className="space-y-4 border-t px-4 py-4">
      {schedule.length > 0 && (
        <p className="text-xs text-muted-foreground">{schedule.join(" · ")}</p>
      )}
      {[submission.clarifications, submission.notes]
        .filter(Boolean)
        .map((text, index) => (
          <p
            key={index}
            className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground"
          >
            {text}
          </p>
        ))}
      {error ? (
        <p className="text-xs text-destructive">
          Unable to load attachments.{" "}
          <Button
            size="sm"
            variant="link"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </Button>
        </p>
      ) : !files ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading attachments…
        </p>
      ) : files.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Quote attachments">
          {files.map((file) => (
            <Attachment
              key={file.id}
              size="sm"
              className="max-w-72 flex-nowrap"
            >
              <AttachmentMedia>
                <FileText />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
              </AttachmentContent>
              {file.url && (
                <AttachmentTrigger asChild>
                  <a
                    href={file.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${file.name}`}
                  />
                </AttachmentTrigger>
              )}
            </Attachment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
