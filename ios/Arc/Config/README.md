# iOS configuration (`.xcconfig`)

The iOS app has **no `.env` file** — iOS reads config from build settings. The
idiomatic equivalent is an `.xcconfig` file: plain `KEY = value` text, one per
build configuration. These expand the placeholders in `Config/AppInfo.plist`, which Xcode merges
with its generated app metadata, and `AppEnvironment.swift`
reads them at runtime, falling back to hardcoded defaults if a value is missing.

## The app needs only a handful of PUBLIC values

You have many server env vars; **almost none of them belong in the app.** The
binary is not private — anything compiled in can be extracted. The app only ever
talks to your own `/api/mobile/v1`, which holds the real secrets server-side.

Ship to the app (all client-safe):

| Variable | Purpose |
|---|---|
| `ARC_API_BASE_URL` | Which backend to call (local / prod) |
| `ARC_SUPABASE_URL` | Supabase project URL (used for token validation) |
| `ARC_SUPABASE_PUBLISHABLE_KEY` | Supabase **publishable/anon** key — safe to ship |
| `ARC_SENTRY_DSN` | Optional crash reporting |

**Never** put these in the app: Supabase service-role key, Stripe secret key,
QBO client secret, R2/storage keys, `DRAWINGS_TILES_COOKIE_SECRET`, etc. They
stay in your Vercel/server env.

## Files

- `AppInfo.plist` — explicit runtime configuration keys expanded from the build settings. Required for launches outside Xcode; arbitrary `INFOPLIST_KEY_Arc…` settings alone are not emitted into a generated plist.

- `Shared.xcconfig` — common, non-secret public defaults; `#include`d by the others. Committed.
- `Debug.xcconfig` — local dev (points API at `127.0.0.1:3000`). Committed.
- `Release.xcconfig` — TestFlight / App Store (prod API). Committed.
- `Secrets.example.xcconfig` — template. Committed.
- `Secrets.xcconfig` — **your** filled-in secrets. **git-ignored.**

## First-time setup

1. Optional: `cp Secrets.example.xcconfig Secrets.xcconfig` for local-only
   overrides such as a different Supabase project or Sentry DSN.
2. In Xcode: select the **Arc** project → **Info** tab → **Configurations**.
   Set **Debug** → "Based on Configuration File" → `Debug`, and **Release** →
   `Release` (do this for both the project and the Arc target rows). One-time.
3. Build & run.

## The one gotcha: `//` in URLs

In `.xcconfig`, `//` starts a comment, so `https://x.supabase.co` truncates to
`https:`. Break it with an empty `$()`:

```
ARC_SUPABASE_URL = https:/$()/abcdefgh.supabase.co
```

## Alternative for quick local tweaks

For one-off overrides you don't want to persist, Xcode **scheme** environment
variables (Edit Scheme → Run → Arguments → Environment Variables) also work and
take precedence — but they only apply when launching from Xcode, not in
TestFlight/App Store builds. `.xcconfig` is the durable, shippable option.
