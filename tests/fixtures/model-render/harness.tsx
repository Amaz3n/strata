import { createRoot } from "react-dom/client";
import { useState } from "react";

import { ModelViewer, type ModelViewerHandle } from "@/components/plans/model-viewer/model-viewer";
import { FINISH_PRESETS } from "@/lib/drawings/architectural-model";
import { furnitureModel, furnitureObject } from "@/lib/drawings/furniture-catalog";
import type { FloorplanModel } from "@/lib/drawings/floorplan-model";

declare global {
  interface Window {
    viewer: ModelViewerHandle | null;
    setTool: (tool: "select" | "measure") => void;
    setSection: (on: boolean) => void;
  }
}

const wall = (id: string, x0: number, y0: number, x1: number, y1: number, thicknessFt = 0.5) => ({ id, x0, y0, x1, y1, thicknessFt, confidence: 1, source: "paired" as const });
const piece = (id: string, modelId: string, xFt: number, yFt: number, rotationDeg = 0) => {
  const model = furnitureModel(modelId);
  if (!model) throw new Error(modelId);
  return { ...furnitureObject(model, { xFt, yFt, rotationDeg }), id };
};

/** A 30' × 20' living/dining room and a 14' × 20' bedroom, furnished from the catalogue. */
const model: FloorplanModel = {
  version: 1,
  units: "feet",
  correctionCount: 0,
  site: { northDeg: 20, latitudeDeg: 33 },
  levels: [
    {
      id: "L0",
      name: "First floor",
      order: 0,
      ceilingHeightFt: 9,
      source: { sheetVersionId: "sv", sheetNumber: "A1", sheetTitle: "Plan", imageWidth: 2000, imageHeight: 1400, feetPerImagePx: 0.025, originPxX: 0, originPxY: 0, scaleConfirmed: true },
      walls: [wall("n", 0, 0, 44, 0), wall("e", 44, 0, 44, 20), wall("s", 44, 20, 0, 20), wall("w", 0, 20, 0, 0), wall("mid", 30, 0, 30, 20, 0.4)],
      openings: [
        { id: "d1", wallId: "mid", kind: "door", offsetFt: 8, widthFt: 3, sillFt: 0, headFt: 6.75, confidence: 1 },
        { id: "w1", wallId: "n", kind: "window", offsetFt: 6, widthFt: 6, sillFt: 2.5, headFt: 7, confidence: 1 },
        { id: "w2", wallId: "s", kind: "window", offsetFt: 10, widthFt: 8, sillFt: 2.5, headFt: 7, confidence: 1 },
      ],
      rooms: [
        { id: "living", polygon: [[0, 0], [30, 0], [30, 20], [0, 20]], label: "LIVING", areaSqft: 600, confidence: 1, finish: { ...FINISH_PRESETS.oak } },
        { id: "bed", polygon: [[30, 0], [44, 0], [44, 20], [30, 20]], label: "BEDROOM", areaSqft: 280, confidence: 1, finish: { ...FINISH_PRESETS.carpet } },
      ],
      objects: [
        piece("sofa", "sofa_02", 9, 0.25 + 1.34, 180),
        piece("coffee", "modern_coffee_table_01", 9, 5.2),
        piece("chair", "ArmChair_01", 15, 5, -90),
        piece("table", "round_wooden_table_01", 21, 13),
        piece("dining-1", "dining_chair_02", 21, 10.4, 180),
        piece("dining-2", "dining_chair_02", 21, 15.6),
        piece("plant", "potted_plant_02", 2, 18),
        piece("dresser", "drawer_cabinet", 41, 0.25 + 0.8, 180),
      ],
      confidence: { walls: 1, openings: 1, rooms: 1 },
    },
  ],
};

function Harness() {
  const [tool, setTool] = useState<"select" | "measure">("select");
  const [section, setSection] = useState(false);
  window.setTool = setTool;
  window.setSection = setSection;
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <ModelViewer
        ref={(handle) => {
          window.viewer = handle;
        }}
        model={model}
        quality="high"
        sunHour={16}
        tool={tool}
        sectionBox={section}
        label="Model render verification"
      />
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Harness />);
