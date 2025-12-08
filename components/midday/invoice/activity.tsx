"use client";

import { cn } from "@midday/ui/cn";
import { format } from "date-fns";
import React from "react";

type ActivityItemProps = {
  label: string;
  date?: string | null;
  completed: boolean;
  isLast?: boolean;
  timeFormat?: number | null;
};

function ActivityItem({
  label,
  date,
  completed,
  isLast,
  timeFormat,
}: ActivityItemProps) {
  return (
    <li className="relative pb-6 last:pb-0">
      {!isLast && (
        <div className="absolute left-[3px] top-[20px] bottom-0 border-[0.5px] border-border" />
      )}

      <div className="flex items-center gap-3">
        <div
          className={cn(
            "relative z-10 flex size-[7px] items-center justify-center rounded-full border border-border",
            completed && "bg-[#666666] border-[#666666]",
          )}
        />

        <div className="flex flex-1 items-center justify-between">
          <span
            className={cn(
              "text-sm",
              completed ? "text-primary" : "text-[#666666]",
            )}
          >
            {label}
          </span>

          <span className="text-sm text-[#666666]">
            {date &&
              format(
                new Date(date),
                `MMM d, ${timeFormat === 24 ? "HH:mm" : "h:mm a"}`,
              )}
          </span>
        </div>
      </div>
    </li>
  );
}

type InvoiceActivityData = {
  createdAt?: string | null;
  sentAt?: string | null;
  scheduledAt?: string | null;
  status?: string | null;
  viewedAt?: string | null;
  reminderSentAt?: string | null;
  paidAt?: string | null;
  updatedAt?: string | null;
};

type Props = {
  data?: InvoiceActivityData;
  timeFormat?: number | null;
};

export function InvoiceActivity({ data, timeFormat }: Props) {
  const completed = data?.paidAt !== null && data?.paidAt !== undefined;

  return (
    <ul>
      {data?.createdAt && (
        <ActivityItem
          label="Created"
          date={data.createdAt}
          completed
          timeFormat={timeFormat ?? null}
        />
      )}
      {data?.sentAt && (
        <ActivityItem
          label="Sent"
          date={data.sentAt}
          completed
          timeFormat={timeFormat ?? null}
        />
      )}
      {data?.scheduledAt && data?.status === "scheduled" && (
        <ActivityItem
          label="Scheduled"
          date={data.scheduledAt}
          completed={!!data.sentAt}
          timeFormat={timeFormat ?? null}
        />
      )}
      {data?.viewedAt && (
        <ActivityItem
          label="Viewed"
          date={data.viewedAt}
          completed
          timeFormat={timeFormat ?? null}
        />
      )}
      {data?.reminderSentAt && (
        <ActivityItem
          label="Reminder sent"
          date={data.reminderSentAt}
          completed
          timeFormat={timeFormat ?? null}
        />
      )}

      {data?.status !== "canceled" && (
        <ActivityItem
          label="Paid"
          date={data?.paidAt}
          completed={completed}
          isLast
          timeFormat={timeFormat ?? null}
        />
      )}

      {data?.status === "canceled" && (
        <ActivityItem
          label="Canceled"
          completed
          date={data?.updatedAt}
          isLast
          timeFormat={timeFormat ?? null}
        />
      )}
    </ul>
  );
}
