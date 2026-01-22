"use client"

import { cn } from "@/lib/utils"

// Curated gradients that look good and are distinguishable
const GRADIENTS = [
  "from-violet-500 to-purple-600",
  "from-blue-500 to-cyan-500",
  "from-emerald-500 to-teal-600",
  "from-orange-500 to-amber-500",
  "from-pink-500 to-rose-500",
  "from-indigo-500 to-blue-600",
  "from-teal-500 to-green-500",
  "from-red-500 to-orange-500",
  "from-fuchsia-500 to-pink-500",
  "from-cyan-500 to-blue-500",
  "from-amber-500 to-yellow-500",
  "from-lime-500 to-emerald-500",
  "from-rose-500 to-red-500",
  "from-sky-500 to-indigo-500",
  "from-purple-500 to-violet-600",
  "from-green-500 to-lime-500",
]

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash)
}

export function getProjectGradient(projectId: string): string {
  const index = hashString(projectId) % GRADIENTS.length
  return GRADIENTS[index]
}

interface ProjectAvatarProps {
  projectId: string
  className?: string
  size?: "sm" | "md" | "lg" | "xl"
}

export function ProjectAvatar({ projectId, className, size = "md" }: ProjectAvatarProps) {
  const gradient = getProjectGradient(projectId)

  const sizeClasses = {
    sm: "size-4 rounded",
    md: "size-5 rounded-md",
    lg: "size-6 rounded-md",
    xl: "size-10 rounded-lg",
  }

  return (
    <div
      className={cn(
        "bg-gradient-to-br shrink-0",
        gradient,
        sizeClasses[size],
        className
      )}
    />
  )
}
