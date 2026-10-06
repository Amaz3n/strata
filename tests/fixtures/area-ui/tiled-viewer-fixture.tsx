/** Deterministic camera surface for shell integration; GPU gestures have their own tests. */
import { useEffect, useRef, useState } from "react";
import type { TiledDrawingViewerProps } from "../../../components/drawings/viewer/tiled-drawing-viewer";
export function TiledDrawingViewer({
  onReady,
  onTransformChange,
  className,
}: TiledDrawingViewerProps) {
  const ref = useRef<HTMLDivElement>(null),
    callbacks = useRef({ onReady, onTransformChange });
  callbacks.current = { onReady, onTransformChange };
  const [camera, setCamera] = useState({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  useEffect(() => {
    const el = ref.current!;
    let zoom = 1;
    const update = () => {
      const { width, height } = el.getBoundingClientRect();
      const scale = (Math.min(width, height) / 1000) * zoom;
      const matrix = {
        a: scale,
        b: 0,
        c: 0,
        d: scale,
        e: (width - 1000 * scale) / 2,
        f: (height - 1000 * scale) / 2,
      };
      setCamera(matrix);
      callbacks.current.onTransformChange?.({
        matrix,
        container: { width, height },
        zoom,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    callbacks.current.onReady?.({
      setGestureOptions: () => {},
      zoomBy: (factor: number) => {
        zoom *= factor;
        update();
      },
      zoomToActualSize: () => {
        zoom = 1;
        update();
      },
      goHome: () => {
        zoom = 1;
        update();
      },
      revealImageRect: () => {
        Object.assign(window, { located: true });
      },
    } as never);
    return () => {
      observer.disconnect();
      callbacks.current.onReady?.(null);
    };
  }, []);
  return (
    <div ref={ref} className={className} data-testid="drawing-surface">
      <svg width="100%" height="100%" style={{ background: "#e7e9eb" }}>
        <g
          transform={`matrix(${camera.a},0,0,${camera.d},${camera.e},${camera.f})`}
        >
          <rect width="1000" height="1000" fill="white" />
          <g stroke="#252a31" strokeWidth="7" fill="none">
            <path d="M100 130H900V860H100ZM500 130V500H900M100 500H500V860M500 130V860" />
            <path
              d="M100 460h55m65 0h280M500 460h55m65 0h280"
              strokeWidth="2"
            />
          </g>
          <g fill="#4a4e55" fontSize="19" fontFamily="sans-serif">
            <text x="220" y="290">
              BEDROOM 1
            </text>
            <text x="620" y="290">
              BEDROOM 2
            </text>
            <text x="220" y="680">
              LIVING
            </text>
            <text x="640" y="680">
              KITCHEN
            </text>
            <text x="100" y="940">
              FIRST FLOOR PLAN · A-2.1
            </text>
          </g>
        </g>
      </svg>
    </div>
  );
}
