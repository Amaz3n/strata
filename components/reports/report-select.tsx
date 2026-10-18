"use client";
import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
const EMPTY = "__report_empty__";
export function ReportSelect({
  value,
  onValueChange,
  children,
  className,
  disabled,
  "aria-label": label,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <Select
      value={value || EMPTY}
      onValueChange={(next) => onValueChange(next === EMPTY ? "" : next)}
      disabled={disabled}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
export function ReportOption({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return <SelectItem value={value || EMPTY}>{children}</SelectItem>;
}
