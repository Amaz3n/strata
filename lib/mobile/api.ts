import { NextResponse } from "next/server"

export class MobileAPIError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message)
    this.name = "MobileAPIError"
  }
}

export function mobileRequestId(request: Request) {
  return request.headers.get("x-request-id")?.trim() || crypto.randomUUID()
}

function mobileHeaders(requestId: string) {
  return {
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
  }
}

export function mobileDataResponse<T>(data: T, requestId: string, init?: ResponseInit) {
  return NextResponse.json(
    { data, meta: { request_id: requestId } },
    { ...init, headers: { ...mobileHeaders(requestId), ...init?.headers } },
  )
}

export function mobilePageResponse<T>(
  data: T[],
  requestId: string,
  nextCursor: string | null,
  init?: ResponseInit,
) {
  return NextResponse.json(
    { data, meta: { request_id: requestId, next_cursor: nextCursor } },
    { ...init, headers: { ...mobileHeaders(requestId), ...init?.headers } },
  )
}

export function mobileErrorResponse(error: unknown, requestId: string) {
  const normalized =
    error instanceof MobileAPIError
      ? error
      : new MobileAPIError(500, "internal_error", "Arc could not complete this request.")

  if (!(error instanceof MobileAPIError)) {
    console.error("Mobile API request failed", { requestId, error })
  }

  return NextResponse.json(
    {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details ? { details: normalized.details } : {}),
      },
      request_id: requestId,
    },
    { status: normalized.status, headers: mobileHeaders(requestId) },
  )
}
