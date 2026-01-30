# Drawings Tiles CDN Worker

This worker protects drawings tiles stored in R2 and serves them via `cdn.arcnaples.com`.

## Setup

1) Copy `wrangler.toml.example` to `wrangler.toml` and adjust if needed.
2) Set secrets:
   - `TILES_COOKIE_SECRET`
   - `TILES_COOKIE_NAME` (optional, default: `arc_tiles`)
3) Deploy with Wrangler.

## Path mapping

Requests to `/drawing-tiles/<key>` map to R2 object key `<key>` in the `drawing-tiles` bucket.
