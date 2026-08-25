const DAY_MS = 86_400_000;
const QUANTITY = 0.01;
const HOLD_MS = 25_000;

function filledHeartbeatCloseCode(openCode) {
  if (typeof openCode !== "string" || !/^SOLHB-\d{8}-OPEN$/.test(openCode)) {
    throw new Error("Stored SOL heartbeat order code is invalid");
  }
  return openCode.replace(/-OPEN$/, "-CLOSE");
}

function cycleCodes(ms) {
  const date = new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
  return Object.freeze({ open: `SOLHB-${date}-OPEN`, close: `SOLHB-${date}-CLOSE` });
}

export function createSolanaHeartbeat({
  persistence,
  adapter,
  isExecutionEnabled,
  isRiskLadderHalted = async () => false,
  acquireMaintenance,
  releaseMaintenance,
  triggerDays = 25,
  addEvent = async () => {},
  notifications = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}) {
  for (const method of ["getLatestFilledAt", "getLatestHeartbeatOpen", "getOrder"]) {
    if (typeof persistence?.[method] !== "function") throw new TypeError(`persistence.${method} is required`);
  }
  if (typeof adapter?.place !== "function") throw new TypeError("heartbeat requires the SOL quantity adapter");
  for (const [name, fn] of Object.entries({ isExecutionEnabled, isRiskLadderHalted, acquireMaintenance, releaseMaintenance, addEvent, now, sleep })) {
    if (typeof fn !== "function") throw new TypeError(`${name} must be a function`);
  }
  if (!Number.isInteger(triggerDays) || triggerDays < 1 || triggerDays >= 30) throw new TypeError("triggerDays must be an integer below the 30-day inactivity deadline");
  if (notifications !== null && typeof notifications?.enqueue !== "function") throw new TypeError("notifications.enqueue must be a function");

  let running = false;

  function enqueueHeartbeat(openOrder, closeOrder, closeCode) {
    if (notifications === null) return;
    notifications.enqueue({
      kind: "HEARTBEAT_CONFIRMED",
      eventKey: `SOL-HEARTBEAT:${closeCode}`,
      quantity: QUANTITY,
      openFillPrice: openOrder.fillPrice,
      closeFillPrice: closeOrder.fillPrice,
      openedAt: openOrder.filledAt,
      closedAt: closeOrder.filledAt
    });
  }

  async function placeHeartbeat({ orderCode, actionType, side }) {
    return adapter.place({
      orderCode,
      strategyId: "sol-outer-heavy-v1",
      instrument: "SOL/USD",
      stateVersion: 0,
      actionType,
      side,
      quantity: QUANTITY
    });
  }

  async function completeCycle(openOrder) {
    const openCode = openOrder.orderCode;
    const closeCode = filledHeartbeatCloseCode(openCode);
    let currentOpen = openOrder;

    if (currentOpen.status !== "FILLED") {
      const result = await placeHeartbeat({ orderCode: openCode, actionType: "HEARTBEAT_OPEN", side: "BUY" });
      if (result.status !== "FILLED" || result.confirmed !== true) {
        await addEvent("WARN", "SOL_HEARTBEAT_OPEN_UNCONFIRMED", { orderCode: openCode, status: result.status ?? "UNKNOWN" });
        return Object.freeze({ status: "OPEN_PENDING", orderCode: openCode });
      }
      currentOpen = await persistence.getOrder(openCode);
      if (!currentOpen || currentOpen.status !== "FILLED") throw new Error("Heartbeat open fill was not persisted");
    }

    const openFillMs = Date.parse(currentOpen.filledAt);
    if (!Number.isFinite(openFillMs)) throw new Error("Heartbeat open fill time is invalid");
    const remainingHold = Math.max(0, HOLD_MS - (now() - openFillMs));
    if (remainingHold > 0) await sleep(remainingHold);

    const existingClose = await persistence.getOrder(closeCode);
    if (existingClose?.status === "FILLED") {
      enqueueHeartbeat(currentOpen, existingClose, closeCode);
      return Object.freeze({ status: "COMPLETE", openCode, closeCode, filledAt: existingClose.filledAt });
    }

    const close = await placeHeartbeat({ orderCode: closeCode, actionType: "HEARTBEAT_CLOSE", side: "SELL" });
    if (close.status !== "FILLED" || close.confirmed !== true) {
      await addEvent("ERROR", "SOL_HEARTBEAT_CLOSE_UNCONFIRMED", { orderCode: closeCode, status: close.status ?? "UNKNOWN" });
      return Object.freeze({ status: "CLOSE_PENDING", openCode, closeCode });
    }
    await addEvent("INFO", "SOL_HEARTBEAT_ROUND_TRIP_CONFIRMED", {
      quantity: QUANTITY,
      openCode,
      closeCode,
      openedAt: currentOpen.filledAt,
      closedAt: close.filledAt
    });
    enqueueHeartbeat(currentOpen, close, closeCode);
    return Object.freeze({ status: "COMPLETE", openCode, closeCode, filledAt: close.filledAt });
  }

  async function checkOnce() {
    if (running) return Object.freeze({ status: "BUSY" });
    if (!isExecutionEnabled()) return Object.freeze({ status: "LOCKED" });
    if (await isRiskLadderHalted()) return Object.freeze({ status: "D049_HALTED_FOR_DAY" });
    running = true;
    let acquired = false;
    try {
      const latestHeartbeatOpen = await persistence.getLatestHeartbeatOpen();
      if (latestHeartbeatOpen) {
        const closeCode = filledHeartbeatCloseCode(latestHeartbeatOpen.orderCode);
        const close = await persistence.getOrder(closeCode);
        if (close?.status !== "FILLED") {
          acquired = await acquireMaintenance();
          if (!acquired) return Object.freeze({ status: "DEFERRED_BUSY" });
          return await completeCycle(latestHeartbeatOpen);
        }
      }

      const latestFilledAt = await persistence.getLatestFilledAt();
      if (!latestFilledAt) {
        await addEvent("WARN", "SOL_HEARTBEAT_BASELINE_UNAVAILABLE", {
          reason: "No confirmed bot/canary trade exists yet"
        });
        return Object.freeze({ status: "NO_BASELINE" });
      }
      const lastMs = Date.parse(latestFilledAt);
      const currentMs = now();
      if (!Number.isFinite(lastMs) || !Number.isFinite(currentMs)) throw new Error("Heartbeat activity time is invalid");
      const ageMs = Math.max(0, currentMs - lastMs);
      if (ageMs < triggerDays * DAY_MS) {
        return Object.freeze({ status: "NOT_DUE", daysSinceTrade: ageMs / DAY_MS });
      }

      acquired = await acquireMaintenance();
      if (!acquired) return Object.freeze({ status: "DEFERRED_BUSY" });
      const codes = cycleCodes(currentMs);
      let open = await persistence.getOrder(codes.open);
      if (!open) {
        await persistence.claimOrder({
          orderCode: codes.open,
          strategyId: "sol-outer-heavy-v1",
          instrument: "SOL/USD",
          stateVersion: 0,
          actionType: "HEARTBEAT_OPEN",
          side: "BUY",
          requestedQuantity: QUANTITY
        });
        open = await persistence.getOrder(codes.open);
      }
      await addEvent("INFO", "SOL_HEARTBEAT_DUE", {
        daysSinceTrade: ageMs / DAY_MS,
        quantity: QUANTITY,
        orderCode: codes.open
      });
      return await completeCycle(open);
    } finally {
      if (acquired) await releaseMaintenance();
      running = false;
    }
  }

  return Object.freeze({
    checkOnce,
    isRunning: () => running,
    triggerDays,
    quantity: QUANTITY,
    holdMs: HOLD_MS
  });
}
