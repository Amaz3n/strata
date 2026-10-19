# Arc marketing videos

Product videos built with [Remotion](https://www.remotion.dev): every shot is React, rendered frame by frame.
This package is separate from the app (own `package.json`, excluded from the root `tsc` and ESLint).

```bash
pnpm install --ignore-workspace   # once
pnpm studio                       # live preview with a timeline
pnpm render payables out/arc-payables.mp4
pnpm render house out/arc-3d-house.mp4     # three.js shots; remotion.config.ts selects the GPU renderer
pnpm still payables out/frame.png --frame=420
```

- `src/kit/` is the reusable part: brand canvas, camera, cursor, AI chips, and stage replicas of Arc UI
  (`arc-ui.tsx`) that copy labels, icons and badge tones from the real components.
- `src/videos/<name>/` holds one video: its data, its scenes, and the shot list in `<Name>Video.tsx`.
- `src/videos/house/plan.ts` is one floor plan that both the 2D sheet and the 3D model are drawn from;
  furniture is the CC0 Poly Haven set the app ships (`public/models/furniture`).
- Show only what Arc really does. Check strings and behavior against the app before scripting a shot.

Remotion needs a paid company license for companies above its free-tier size: see remotion.dev/license.
