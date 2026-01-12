'use client'

import { useState, useEffect } from 'react'

/**
 * Hook to detect if the current device supports touch input.
 * Returns true for touch-capable devices (phones, tablets, touch laptops).
 */
export function useIsTouchDevice() {
  const [isTouch, setIsTouch] = useState(false)

  useEffect(() => {
    setIsTouch(
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0
    )
  }, [])

  return isTouch
}
