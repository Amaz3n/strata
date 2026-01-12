# Drawing Performance Baseline

**Created:** 2026-01-04
**Phase:** 0 - Measurement & Validation

## Current Implementation

The drawings viewer uses **react-pdf** for client-side PDF rendering. This approach has inherent performance limitations that are being tracked.

### Performance Tracking Added

Performance instrumentation has been added to track the complete loading flow:

1. **pdfImport** - Time to dynamically import react-pdf bundle (~2MB)
2. **workerLoad** - Time to configure PDF.js worker URL
3. **pdfParsing** - Time for PDF.js to parse the PDF document
4. **rendering** - Time to render the PDF page to canvas

For non-PDF files (images):
1. **fullLoad** - Time to load and display the image

### How to View Performance Data

#### Console Logs
Open the browser console to see detailed timing breakdowns:
```
[Drawing Performance] Started timing for sheet abc123
[Drawing Performance] PDF.js import: 342ms
[Drawing Performance] Worker config: 2ms
[Drawing Performance] PDF document loaded
[Drawing Performance] pdfParsing: 1234ms
[Drawing Performance] PDF page rendered
[Drawing Performance] rendering: 1456ms

📊 Drawing Performance Report - abc123
Total Load Time: 1456ms
Device: desktop
Connection: 4g
File Type: PDF
┌─────────────┬───────┐
│   Phase     │  Time │
├─────────────┼───────┤
│ pdfImport   │  342  │
│ workerLoad  │  344  │
│ pdfParsing  │ 1234  │
│ rendering   │ 1456  │
└─────────────┴───────┘
🟠 Performance: NEEDS IMPROVEMENT (<3s) - Target: <300ms
```

#### Vercel Analytics
Custom events are sent to Vercel Analytics:

- **drawing_loaded** - Fires when drawing is fully loaded
  - `sheetId`: The sheet identifier
  - `loadTime`: Total load time in ms
  - `device`: desktop | mobile | tablet
  - `connection`: 4g | 3g | slow | unknown
  - `isPdf`: boolean

- **drawing_performance_rating** - Performance classification
  - `rating`: excellent (<300ms) | good (<1s) | needs_improvement (<3s) | poor (>3s)
  - `loadTime`: Total load time in ms
  - `device`: desktop | mobile | tablet

## Expected Baseline Performance (Pre-Optimization)

Based on the current react-pdf implementation:

### Desktop (Chrome, Fast WiFi)
| Phase | Expected Time |
|-------|---------------|
| PDF.js Import | 200-400ms |
| Worker Config | ~5ms |
| PDF Download | 200-800ms (size dependent) |
| PDF Parsing | 300-600ms |
| Rendering | 200-400ms |
| **Total** | **1-3 seconds** |

### Mobile (Safari, 4G)
| Phase | Expected Time |
|-------|---------------|
| PDF.js Import | 400-800ms |
| Worker Config | ~10ms |
| PDF Download | 400-1500ms |
| PDF Parsing | 500-1200ms |
| Rendering | 300-600ms |
| **Total** | **2-5 seconds** |

### Tablet (iPad, WiFi)
| Phase | Expected Time |
|-------|---------------|
| PDF.js Import | 300-500ms |
| Worker Config | ~5ms |
| PDF Download | 300-1000ms |
| PDF Parsing | 400-800ms |
| Rendering | 300-500ms |
| **Total** | **1.5-3.5 seconds** |

## Target Performance (Post-Optimization)

With image-based rendering (Phase 1):

| Stage | Target Time |
|-------|-------------|
| Thumbnail visible | < 100ms |
| Medium-res loaded | < 200ms |
| Full-res loaded | < 500ms |
| **First Visible** | **< 100ms** |
| **Fully Loaded** | **< 300ms** |

## Performance Ratings

| Rating | Load Time | Status |
|--------|-----------|--------|
| Excellent | < 300ms | Target met |
| Good | < 1000ms | Acceptable |
| Needs Improvement | < 3000ms | Optimize soon |
| Poor | > 3000ms | Critical - requires fix |

## Testing Procedure

### Manual Testing

1. Open browser DevTools (Console tab)
2. Navigate to a project with drawings
3. Click on a drawing sheet to open the viewer
4. Observe console output for timing breakdown
5. Repeat 5+ times for consistent measurements

### Device Testing Matrix

Test on real devices with the following conditions:

| Device | Browser | Network | Expected Baseline |
|--------|---------|---------|-------------------|
| MacBook Pro | Chrome | Fast WiFi | 1-2s |
| iPhone 14 | Safari | 4G | 3-5s |
| iPhone 14 | Safari | 3G throttled | 5-8s |
| iPad Pro | Safari | WiFi | 2-3s |
| Android Phone | Chrome | 4G | 3-5s |

### Chrome DevTools Throttling

To simulate slow network conditions:

1. Open DevTools → Network tab
2. Select "Slow 3G" or "Fast 3G" preset
3. Reload the drawing
4. Note the load time

## Data Collection Template

After testing, document your findings:

```markdown
## Drawing Performance Baseline (DATE)

### Desktop (Chrome, fast WiFi)
- Average load time: X.Xs
- P50: X.Xs
- P95: X.Xs

### Mobile (Safari, 4G)
- Average load time: X.Xs
- P50: X.Xs
- P95: X.Xs

### Key Bottlenecks Identified
1.
2.
3.

### Notes
-
```

## Next Steps

After collecting baseline data:

1. Document actual measured values above
2. Identify the largest time-consuming phases
3. Proceed to Phase 1: Image Generation
4. Compare post-optimization metrics to baseline

---

*This document is part of the Drawings Performance Optimization project.*
