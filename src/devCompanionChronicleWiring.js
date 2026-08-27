import { createChronicleControl } from "./devCompanionChronicleControl.js";

export function wrapCompanionWithChronicleControl(store) {
  const control = createChronicleControl({ store });
  return Object.freeze({
    ...store,
    chronicleStatus: control.chronicleStatus,
    chroniclePause: control.chroniclePause,
    chronicleResume: control.chronicleResume
  });
}
