import { z } from "zod";
import type { ProjectScheduleSummary, ProjectStatus } from "@/lib/types";

export const PROJECT_DIRECTORY_PAGE_SIZE = 50;
export const projectDirectoryQuerySchema = z.object({
  community: z.union([z.literal("all"), z.string().uuid()]).optional(),
  q: z.string().trim().max(200).default(""),
  status: z
    .enum([
      "all",
      "planning",
      "bidding",
      "active",
      "on_hold",
      "completed",
      "cancelled",
    ])
    .default("all"),
  sort: z
    .enum(["name", "client", "status", "progress", "value"])
    .default("name"),
  direction: z.enum(["asc", "desc"]).default("asc"),
  cursor: z.string().max(4096).optional(),
});
export type ProjectDirectoryQuery = z.infer<typeof projectDirectoryQuerySchema>;
export type ProjectDirectoryRow = {
  id: string;
  name: string;
  status: ProjectStatus;
  address: string;
  client_name: string;
  value_cents: number | null;
  summary: ProjectScheduleSummary | null;
};
export type ProjectDirectoryPage = {
  rows: ProjectDirectoryRow[];
  nextCursor: string | null;
};

export function directoryQueryKey(query: ProjectDirectoryQuery): string {
  return JSON.stringify([
    query.community ?? "",
    query.q,
    query.status,
    query.sort,
    query.direction,
    query.cursor ?? "",
  ]);
}

export const directoryCursorSchema = z.object({
  text: z.string().max(2000),
  number: z.number().finite(),
  name: z.string().max(2000),
  id: z.string().uuid(),
});
