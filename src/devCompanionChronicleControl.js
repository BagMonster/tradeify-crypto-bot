export function createChronicleControl({ store }) {
  if (typeof store?.isChroniclePaused !== "function") {
    throw new TypeError("store.isChroniclePaused must be a function");
  }

  async function chronicleStatus() {
    const paused = await store.isChroniclePaused();
    return {
      paused,
      message: [
        "CHRONICLE PUBLISHING KILL SWITCH",
        "",
        `State: ${paused ? "PAUSED" : "ARMED"}`,
        "This is not editorial review. It only stops or allows BMTB1's autonomous publish tool.",
        "Activation still requires CHRONICLE_AUTONOMOUS_PUBLISH=true on the companion worker.",
        "A paused switch cannot place orders, merge non-chronicle PRs, or deploy Railway."
      ].join("\n")
    };
  }

  async function chroniclePause() {
    await store.setChroniclePaused(true);
    return {
      paused: true,
      message: "Chronicle publishing is PAUSED. New autonomous entries will fail closed until /chronicleresume."
    };
  }

  async function chronicleResume() {
    await store.setChroniclePaused(false);
    return {
      paused: false,
      message: "Chronicle publishing kill switch is ARMED. Entries still require the companion env flag."
    };
  }

  return Object.freeze({ chronicleStatus, chroniclePause, chronicleResume });
}
