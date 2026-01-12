'use client'

import { useRef, useEffect, useCallback } from 'react'

interface TouchGestureHandlers {
  onPinchZoom?: (scale: number, center: { x: number; y: number }) => void
  onPan?: (deltaX: number, deltaY: number) => void
  onSwipeLeft?: () => void
  onSwipeRight?: () => void
  onDoubleTap?: (position: { x: number; y: number }) => void
  onLongPress?: (position: { x: number; y: number }) => void
  onTap?: (position: { x: number; y: number }) => void
}

interface UseTouchGesturesOptions {
  enabled?: boolean
  longPressDelay?: number
  swipeThreshold?: number
  handlers: TouchGestureHandlers
}

export function useTouchGestures({
  enabled = true,
  longPressDelay = 500,
  swipeThreshold = 50,
  handlers,
}: UseTouchGesturesOptions) {
  const elementRef = useRef<HTMLDivElement>(null)
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const lastTapRef = useRef<number>(0)
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null)
  const initialDistanceRef = useRef<number | null>(null)
  const isPinchingRef = useRef(false)
  const hasMovedRef = useRef(false)

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const getDistance = useCallback((touch1: Touch, touch2: Touch) => {
    const dx = touch1.clientX - touch2.clientX
    const dy = touch1.clientY - touch2.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }, [])

  const getCenter = useCallback((touch1: Touch, touch2: Touch) => ({
    x: (touch1.clientX + touch2.clientX) / 2,
    y: (touch1.clientY + touch2.clientY) / 2,
  }), [])

  useEffect(() => {
    if (!enabled) return

    const element = elementRef.current
    if (!element) return

    const handleTouchStart = (e: TouchEvent) => {
      clearLongPress()
      hasMovedRef.current = false

      if (e.touches.length === 2) {
        // Pinch start
        isPinchingRef.current = true
        initialDistanceRef.current = getDistance(e.touches[0], e.touches[1])
        return
      }

      if (e.touches.length === 1) {
        const touch = e.touches[0]
        touchStartRef.current = {
          x: touch.clientX,
          y: touch.clientY,
          time: Date.now(),
        }

        // Start long press timer
        longPressTimerRef.current = setTimeout(() => {
          if (!hasMovedRef.current) {
            const rect = element.getBoundingClientRect()
            handlers.onLongPress?.({
              x: (touch.clientX - rect.left) / rect.width,
              y: (touch.clientY - rect.top) / rect.height,
            })
            touchStartRef.current = null // Prevent other gestures
          }
        }, longPressDelay)
      }
    }

    const handleTouchMove = (e: TouchEvent) => {
      clearLongPress()

      if (e.touches.length === 2 && isPinchingRef.current && initialDistanceRef.current) {
        // Pinch zoom
        const currentDistance = getDistance(e.touches[0], e.touches[1])
        const scale = currentDistance / initialDistanceRef.current
        const center = getCenter(e.touches[0], e.touches[1])

        const rect = element.getBoundingClientRect()
        handlers.onPinchZoom?.(scale, {
          x: (center.x - rect.left) / rect.width,
          y: (center.y - rect.top) / rect.height,
        })

        initialDistanceRef.current = currentDistance
        e.preventDefault()
        return
      }

      if (e.touches.length === 1 && touchStartRef.current) {
        const touch = e.touches[0]
        const deltaX = touch.clientX - touchStartRef.current.x
        const deltaY = touch.clientY - touchStartRef.current.y

        // If moved significantly, mark as moved
        if (Math.abs(deltaX) > 10 || Math.abs(deltaY) > 10) {
          hasMovedRef.current = true
          handlers.onPan?.(deltaX, deltaY)
          touchStartRef.current = {
            x: touch.clientX,
            y: touch.clientY,
            time: touchStartRef.current.time,
          }
        }
      }
    }

    const handleTouchEnd = (e: TouchEvent) => {
      clearLongPress()

      if (isPinchingRef.current) {
        isPinchingRef.current = false
        initialDistanceRef.current = null
        return
      }

      if (!touchStartRef.current) return

      const touch = e.changedTouches[0]
      const deltaX = touch.clientX - touchStartRef.current.x
      const deltaY = touch.clientY - touchStartRef.current.y
      const deltaTime = Date.now() - touchStartRef.current.time

      const rect = element.getBoundingClientRect()
      const position = {
        x: (touch.clientX - rect.left) / rect.width,
        y: (touch.clientY - rect.top) / rect.height,
      }

      // Check for swipe (quick, horizontal movement)
      if (deltaTime < 300 && Math.abs(deltaX) > swipeThreshold && Math.abs(deltaY) < 50) {
        if (deltaX < 0) {
          handlers.onSwipeLeft?.()
        } else {
          handlers.onSwipeRight?.()
        }
        touchStartRef.current = null
        return
      }

      // Check for double tap
      const now = Date.now()
      if (now - lastTapRef.current < 300 && Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) {
        handlers.onDoubleTap?.(position)
        lastTapRef.current = 0
      } else if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10 && !hasMovedRef.current) {
        // Single tap
        handlers.onTap?.(position)
        lastTapRef.current = now
      }

      touchStartRef.current = null
    }

    element.addEventListener('touchstart', handleTouchStart, { passive: false })
    element.addEventListener('touchmove', handleTouchMove, { passive: false })
    element.addEventListener('touchend', handleTouchEnd)

    return () => {
      element.removeEventListener('touchstart', handleTouchStart)
      element.removeEventListener('touchmove', handleTouchMove)
      element.removeEventListener('touchend', handleTouchEnd)
      clearLongPress()
    }
  }, [enabled, handlers, longPressDelay, swipeThreshold, clearLongPress, getDistance, getCenter])

  return elementRef
}
