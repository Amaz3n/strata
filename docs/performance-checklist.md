# Strata Performance Checklist

Use this checklist for every performance-related PR to ensure changes maintain or improve app snappiness.

## Routing/Layout Checklist
- [ ] Shell is in a shared `layout.tsx` and does not remount per page navigation
- [ ] `loading.tsx` fallbacks are placed at the **smallest** segment that makes sense
- [ ] Navigation uses Next `<Link>` (no full reloads)

## Caching Checklist
- [ ] No blanket `force-dynamic`; only where required
- [ ] Mutations revalidate the smallest necessary paths (avoid global revalidate)
- [ ] Data payloads are minimized to required columns

## Data + Auth Context Checklist
- [ ] Auth/org context is computed once per request (memoized)
- [ ] Services accept context when available; do not re-derive repeatedly

## Middleware Checklist
- [ ] Middleware avoids DB work where possible
- [ ] Any remaining middleware work is justified and measured

## Client Performance Checklist
- [ ] Client components are minimized; heavy widgets are lazy-loaded
- [ ] Large lists are virtualized (if needed)
- [ ] Avoid expensive mount-time `useEffect` in shell

## Verification Checklist
- [ ] Before/after measurements captured (TTFB/LCP/INP, route transition timings)
- [ ] Supabase logs checked for query count/time changes on hot routes

## Performance Measurements (Fill in before/after)

### Web Vitals
- **TTFB (median)**: ____ ms → ____ ms
- **LCP (p75)**: ____ s → ____ s
- **INP (p75)**: ____ ms → ____ ms
- **CLS**: ____ → ____

### Route Transition Timings
- Common navigation (e.g., `/projects` → `/projects/[id]`): ____ ms → ____ ms
- List pages load time: ____ ms → ____ ms

### Database Queries
- Average queries per request: ____ → ____
- Supabase query time (median): ____ ms → ____ ms

## Key User Flows Tested
1. `/projects` → `/projects/[id]` → `/projects/[id]/schedule`
2. `/projects` → `/directory`
3. `/projects/[id]` → `/projects/[id]/files`
4. `/projects/[id]/financials` load
5. `/tasks` list + interactions

## Notes
[Any additional performance observations or concerns]


