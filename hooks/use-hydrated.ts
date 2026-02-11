import { useEffect, useState } from "react"

/**
 * Returns true after the first client mount.
 * Useful for deferring client-only UI trees until after hydration.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    setHydrated(true)
  }, [])

  return hydrated
}
