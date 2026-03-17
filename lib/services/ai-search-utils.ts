import type { SearchEntityType } from "@/lib/services/search"

export function formatEntityTypeForAi(type: SearchEntityType) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}
