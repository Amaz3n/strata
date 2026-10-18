import { createRoot } from "react-dom/client";
import { useState } from "react";
import { useMeasureTools } from "../../../components/drawings/viewer/use-measure-tools"
import { useAreaTakeoff } from "../../../components/drawings/viewer/use-area-takeoff";
import { AreaTakeoffOverlay } from "../../../components/drawings/viewer/area-overlay";
import type { TakeoffCondition } from "../../../lib/services/takeoff";
const items = [
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "LVP Flooring",
    uom: "sf",
    waste_pct: 10,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Tile",
    uom: "sy",
    waste_pct: 0,
  },
] as TakeoffCondition[];
function Harness() {
  const [version, setVersion] = useState(
    "11111111-1111-4111-8111-111111111111",
  );
  const [scale, setScale] = useState(0.02);
  const c = useAreaTakeoff({
    sheetVersionId: version,
    conditionId: null,
    scale,
    imageSize: { width: 1000, height: 1000 },
    allowed: true,
    onSaved: () => {
      Object.assign(window, { saved: true });
    },
  });
  const countTools = useMeasureTools({imageSize:{width:1000,height:1000},feetPerImagePx:scale,onCommit:async()=>{Object.assign(window,{cancelledCountSaved:true})}})
  Object.assign(window, {
    areaController: c,
    countTools,
    fill: (point: [number, number], index: number) => c.fillAt(point, items[index]),
    fillAll: (index: number) => c.fillAll(items[index]),
  });
  return (
    <div className="h-screen bg-muted text-foreground">
      <header className="flex h-14 gap-4 border-b bg-background px-4">
        <button onClick={c.activate}>Find floor areas</button>
        <button
          onClick={() =>
            setVersion(
              version.startsWith("111")
                ? "33333333-3333-4333-8333-333333333333"
                : "11111111-1111-4111-8111-111111111111",
            )
          }
        >
          Switch sheet
        </button>
        <button onClick={() => setScale(0.03)}>Change scale</button>
        <button
          onClick={() =>
            c.addManual([
              [0.1, 0.1],
              [0.3, 0.1],
              [0.3, 0.3],
              [0.1, 0.3],
            ])
          }
        >
          Draw test area
        </button>
      </header>
      <svg
        className="absolute left-0 top-14 bottom-0"
        width="900"
        height="850"
        viewBox="0 0 1000 1000"
      >
        <AreaTakeoffOverlay
          controller={c}
          imageSize={{ width: 1000, height: 1000 }}
        />
      </svg>
      <aside className="absolute right-0 top-14 bottom-0 w-[360px] border-l p-4 text-sm" aria-label="Automatic area review">
        {c.open && (
          <p>
            {c.busy === "detecting"
              ? "Finding rooms on this sheet…"
              : `${c.proposals.length} rooms found`}
          </p>
        )}
        {c.error && <p role="alert">{c.error}</p>}
      </aside>
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Test root missing");
createRoot(root).render(<Harness />);
