import { AbsoluteFill, Sequence } from "remotion";
import { Scene } from "../../kit/canvas";
import { BuyerPhone, EndCard, Hook, RenderPhoto, Rise, ScanCloseUp, SunSweep, Walkthrough, Workspace } from "./scenes";

const OVERLAP = 10;
const SHOTS = [
  { name: "Hook", length: 80, Shot: Hook },
  { name: "Workspace", length: 140, Shot: Workspace },
  { name: "Scan", length: 135, Shot: ScanCloseUp },
  { name: "Rise", length: 240, Shot: Rise },
  { name: "Sun", length: 160, Shot: SunSweep },
  { name: "Walkthrough", length: 140, Shot: Walkthrough },
  { name: "Photo", length: 120, Shot: RenderPhoto },
  { name: "Phone", length: 150, Shot: BuyerPhone },
  { name: "End", length: 100, Shot: EndCard },
];

export const HOUSE_DURATION = SHOTS.reduce((sum, s) => sum + s.length, 0) - OVERLAP * (SHOTS.length - 1);

// Where each shot starts, for rendering stills of one shot.
export const HOUSE_SHOT_STARTS = SHOTS.reduce<Record<string, number>>((acc, s, i) => {
  acc[s.name] = SHOTS.slice(0, i).reduce((sum, p) => sum + p.length - OVERLAP, 0);
  return acc;
}, {});

export function HouseVideo() {
  let from = 0;
  return (
    <AbsoluteFill style={{ background: "black" }}>
      {SHOTS.map(({ name, length, Shot }, i) => {
        const start = from;
        from += length - OVERLAP;
        return (
          <Sequence key={name} name={name} from={start} durationInFrames={length} premountFor={30}>
            <Scene duration={length} inFrames={i === 0 ? 0 : OVERLAP} outFrames={i === SHOTS.length - 1 ? 0 : OVERLAP}>
              <Shot />
            </Scene>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
}
