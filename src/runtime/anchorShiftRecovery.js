// Shared production wiring for the monitor publisher, recovery command and
// independent cached-snapshot watcher. No execution or broker-order interface.
export function createAnchorShiftRecovery({ accountMonitor, coordinator, setTimer = setTimeout, clearTimer = clearTimeout, logError = console.error }) {
  let timer = null;
  let busy = false;
  let stopped = false;
  function arm() {
    if (stopped || timer !== null || coordinator.getSnapshot().pending !== true) return;
    timer = setTimer(() => {
      timer = null;
      return confirm();
    }, 1_000);
    timer?.unref?.();
  }
  async function observe(snapshot) {
    const status = accountMonitor.getSnapshot();
    // A delayed publication must not validate an obsolete cached snapshot.
    const result = await coordinator.observe(status.healthy === true && status.snapshot
      ? status.snapshot
      : { ...(snapshot ?? {}), accountLocked: true, signedNetReadOk: false });
    arm();
    return result;
  }
  async function confirm() {
    if (busy || stopped || coordinator.getSnapshot().pending !== true) return;
    busy = true;
    try {
      return await observe(accountMonitor.getSnapshot().snapshot);
    } catch (error) {
      // Application failures are handled terminally inside the coordinator.
      // This is only an unexpected wiring failure; never print broker payloads.
      logError("Anchor shift confirmation check failed: unexpected coordinator error");
      return await coordinator.abort();
    } finally {
      busy = false;
      arm();
    }
  }
  async function recover() {
    const snapshot = await accountMonitor.pollOnce();
    if (accountMonitor.getSnapshot().healthy !== true) return Object.freeze({ action: "RECOVERY_REFUSED" });
    const result = await coordinator.beginVerifiedFlatRecovery(snapshot);
    arm();
    return result;
  }
  function stop() {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  return Object.freeze({ observe, confirm, recover, stop });
}
