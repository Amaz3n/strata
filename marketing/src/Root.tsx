import { Composition } from "remotion";
import { FPS } from "./kit/brand";
import { HOUSE_DURATION, HouseVideo } from "./videos/house/HouseVideo";
import { PAYABLES_DURATION, PayablesVideo } from "./videos/payables/PayablesVideo";

export function Root() {
  return (
    <>
      <Composition id="payables" component={PayablesVideo} durationInFrames={PAYABLES_DURATION} fps={FPS} width={1920} height={1080} />
      <Composition id="house" component={HouseVideo} durationInFrames={HOUSE_DURATION} fps={FPS} width={1920} height={1080} />
    </>
  );
}
