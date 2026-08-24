const STRATEGY_ID = "sol-outer-heavy-v1";
const INSTRUMENT = "SOL/USD";
const CANARY_QUANTITY = 0.01;
const OPEN_CODE = "SOLCANARY-V2-OPEN";
const CLOSE_CODE = "SOLCANARY-V2-CLOSE";
const FINAL_FAILURES = new Set(["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"]);

function text(name, value, max = 128) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  const out = value.trim();
  if (out.length > max) throw new TypeError(`${name} is too long`);
  return out;
}

function positionRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray(payload.positions)) return payload.positions;
  throw new Error("DXtrade open-positions response does not contain a positions array");
}

function positionSymbol(position) {
  return String(position?.symbol ?? position?.instrument ?? "").trim();
}

function positionQuantity(position) {
  const value = Number(position?.quantity ?? position?.qty);
  if (!Number.isFinite(value)) throw new Error("DXtrade SOL position quantity is invalid");
  return value;
}

function positionCode(position) {
  const value = position?.positionCode ?? position?.code ?? position?.id;
  return text("DXtrade position code", value == null ? "" : String(value), 128);
}

function activePositions(payload) {
  return positionRows(payload).filter((position) => Math.abs(positionQuantity(position)) > 1e-12);
}

async function reconcileClose({ client, persistence, quantity, sleep, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await client.reconcileQuantityOrder({
      orderCode: CLOSE_CODE,
      requestedQuantity: quantity
    });
    if (result.status === "FILLED") {
      await persistence.markStatus(CLOSE_CODE, "FILLED", {
        fillPrice: result.fillPrice,
        filledQuantity: result.filledQuantity,
        filledAt: result.filledAt
      });
      return Object.freeze({ confirmed: true, ...result });
    }
    if (FINAL_FAILURES.has(result.status)) {
      await persistence.markStatus(CLOSE_CODE, result.status, {
        lastError: `SOL canary close ended ${result.status}`
      });
      return Object.freeze({ confirmed: false, status: result.status });
    }
    await persistence.markStatus(CLOSE_CODE, "PENDING");
    if (Date.now() >= deadline) {
      return Object.freeze({ confirmed: false, status: "PENDING" });
    }
    await sleep(750);
  }
}

export function createSolanaLiveCanary({
  adapter,
  client,
  persistence,
  addEvent = async () => {},
  automaticExecutionEnabled,
  minimumHoldSeconds = 25,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  confirmationTimeoutMs = 12_000
}) {
  if (typeof adapter?.place !== "function") throw new TypeError("SOL canary requires the quantity adapter");
  if (typeof client?.getOpenPositions !== "function" || typeof client?.placePositionClose !== "function" || typeof client?.reconcileQuantityOrder !== "function") {
    throw new TypeError("SOL canary requires DXtrade position and reconciliation methods");
  }
  if (!persistence || typeof persistence.getOrder !== "function" || typeof persistence.claimOrder !== "function" || typeof persistence.markSubmitted !== "function" || typeof persistence.markStatus !== "function") {
    throw new TypeError("SOL canary requires persistent execution storage");
  }
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  if (typeof automaticExecutionEnabled !== "function") throw new TypeError("automaticExecutionEnabled must be a function");
  if (!Number.isInteger(minimumHoldSeconds) || minimumHoldSeconds < 25 || minimumHoldSeconds > 300) {
    throw new TypeError("minimumHoldSeconds must be an integer from 25 to 300");
  }
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
  if (!Number.isInteger(confirmationTimeoutMs) || confirmationTimeoutMs < 1_000 || confirmationTimeoutMs > 60_000) {
    throw new TypeError("confirmationTimeoutMs is invalid");
  }

  let busy = false;

  async function run({ stateVersion = 0 } = {}) {
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) throw new TypeError("stateVersion must be a non-negative safe integer");
    if (busy) return Object.freeze({ status: "BUSY", message: "SOL live canary is already running." });
    if (automaticExecutionEnabled()) {
      return Object.freeze({
        status: "BLOCKED",
        message: "SOL live canary requires automatic grid execution to remain OFF."
      });
    }

    busy = true;
    try {
      const existingOpen = await persistence.getOrder(OPEN_CODE);
      const existingClose = await persistence.getOrder(CLOSE_CODE);
      if (existingOpen?.status === "FILLED" && existingClose?.status === "FILLED") {
        const positions = activePositions(await client.getOpenPositions());
        if (positions.length !== 0) {
          return Object.freeze({ status: "REVIEW_REQUIRED", message: "The recorded SOL canary is complete but the broker account is not flat." });
        }
        return Object.freeze({ status: "COMPLETE", message: "The 0.01 SOL live canary already completed and the broker account is flat." });
      }

      if (!existingOpen) {
        const positions = activePositions(await client.getOpenPositions());
        if (positions.length !== 0) {
          return Object.freeze({ status: "BLOCKED", message: "SOL live canary requires the broker account to be flat before opening." });
        }
      }

      await addEvent("WARN", "SOL_CANARY_STARTED", {
        orderCode: OPEN_CODE,
        quantity: CANARY_QUANTITY,
        automaticExecution: false
      });

      const opened = await adapter.place({
        orderCode: OPEN_CODE,
        strategyId: STRATEGY_ID,
        instrument: INSTRUMENT,
        stateVersion,
        actionType: "CANARY_OPEN",
        side: "BUY",
        quantity: CANARY_QUANTITY
      });
      if (opened.confirmed !== true || opened.status !== "FILLED") {
        const openStatus = opened.status ?? "NOT_CONFIRMED";
        const brokerPositions = activePositions(await client.getOpenPositions());
        const solPositions = brokerPositions.filter((position) => positionSymbol(position) === INSTRUMENT);
        const foreignPositions = brokerPositions.filter((position) => positionSymbol(position) !== INSTRUMENT);
        await addEvent("ERROR", "SOL_CANARY_OPEN_NOT_CONFIRMED", {
          status: openStatus,
          brokerPositionCount: brokerPositions.length,
          solPositionCount: solPositions.length,
          foreignPositionCount: foreignPositions.length
        });

        if (brokerPositions.length === 0) {
          return Object.freeze({
            status: openStatus,
            message: `The SOL canary open is ${openStatus}. DXtrade currently reports the broker account flat. No second order was sent.`
          });
        }

        if (foreignPositions.length === 0 && solPositions.length === 1) {
          const signedQuantity = positionQuantity(solPositions[0]);
          return Object.freeze({
            status: "REVIEW_REQUIRED",
            message: `The SOL canary open was not confirmed by order history (${openStatus}), but DXtrade currently reports a SOL/USD position of ${signedQuantity.toFixed(2)} SOL. No second order was sent.`
          });
        }

        return Object.freeze({
          status: "REVIEW_REQUIRED",
          message: `The SOL canary open was not confirmed (${openStatus}) and DXtrade reports an unexpected broker position set. No second order was sent.`
        });
      }

      await addEvent("WARN", "SOL_CANARY_OPEN_CONFIRMED", {
        quantity: opened.filledQuantity,
        fillPrice: opened.fillPrice,
        filledAt: opened.filledAt
      });

      const holdUntil = Date.parse(opened.filledAt) + minimumHoldSeconds * 1_000;
      const remainingHold = Math.max(0, holdUntil - Date.now());
      if (remainingHold > 0) await sleep(remainingHold);

      const positions = activePositions(await client.getOpenPositions());
      const foreign = positions.filter((position) => positionSymbol(position) !== INSTRUMENT);
      const sol = positions.filter((position) => positionSymbol(position) === INSTRUMENT);
      if (foreign.length > 0 || sol.length !== 1) {
        await addEvent("ERROR", "SOL_CANARY_CLOSE_BLOCKED", { reason: "unexpected-position-set" });
        return Object.freeze({ status: "REVIEW_REQUIRED", message: "The SOL canary open filled, but the broker position set is not the expected single SOL/USD position. Close was not guessed." });
      }

      const position = sol[0];
      const signedQuantity = positionQuantity(position);
      if (signedQuantity <= 0) {
        await addEvent("ERROR", "SOL_CANARY_CLOSE_BLOCKED", { reason: "unexpected-position-direction" });
        return Object.freeze({ status: "REVIEW_REQUIRED", message: "The SOL canary expected a long SOL/USD broker position after the BUY fill." });
      }
      const closeQuantity = Math.abs(signedQuantity);
      if (Math.abs(closeQuantity - opened.filledQuantity) > 1e-8) {
        await addEvent("ERROR", "SOL_CANARY_CLOSE_BLOCKED", { reason: "quantity-mismatch" });
        return Object.freeze({ status: "REVIEW_REQUIRED", message: "The SOL broker quantity does not match the confirmed canary fill, so automatic close was not guessed." });
      }

      let closeRow = await persistence.getOrder(CLOSE_CODE);
      if (!closeRow) {
        closeRow = await persistence.claimOrder({
          orderCode: CLOSE_CODE,
          strategyId: STRATEGY_ID,
          instrument: INSTRUMENT,
          stateVersion,
          actionType: "CANARY_CLOSE",
          side: "SELL",
          requestedQuantity: closeQuantity
        });
      }

      if (closeRow.status === "CLAIMED") {
        const response = await client.placePositionClose({
          orderCode: CLOSE_CODE,
          orderSide: "SELL",
          quantity: closeQuantity,
          positionCode: positionCode(position)
        });
        closeRow = await persistence.markSubmitted(CLOSE_CODE, response?.orderId ?? null);
      }

      let closed;
      if (closeRow.status === "FILLED") {
        closed = Object.freeze({
          confirmed: true,
          status: "FILLED",
          fillPrice: closeRow.fillPrice,
          filledQuantity: closeRow.filledQuantity,
          filledAt: closeRow.filledAt
        });
      } else if (FINAL_FAILURES.has(closeRow.status)) {
        closed = Object.freeze({ confirmed: false, status: closeRow.status });
      } else {
        closed = await reconcileClose({
          client,
          persistence,
          quantity: closeQuantity,
          sleep,
          timeoutMs: confirmationTimeoutMs
        });
      }

      if (closed.confirmed !== true || closed.status !== "FILLED") {
        await addEvent("ERROR", "SOL_CANARY_CLOSE_NOT_CONFIRMED", { status: closed.status ?? "UNKNOWN" });
        return Object.freeze({ status: closed.status ?? "NOT_CONFIRMED", message: "The SOL canary close was not confirmed. Review DXtrade before retrying anything." });
      }

      const finalPositions = activePositions(await client.getOpenPositions());
      if (finalPositions.length !== 0) {
        await addEvent("ERROR", "SOL_CANARY_NOT_FLAT", { positionCount: finalPositions.length });
        return Object.freeze({ status: "REVIEW_REQUIRED", message: "The canary close filled, but DXtrade still reports an open position." });
      }

      await addEvent("WARN", "SOL_CANARY_COMPLETE", {
        quantity: closeQuantity,
        openPrice: opened.fillPrice,
        closePrice: closed.fillPrice,
        automaticExecution: false
      });

      return Object.freeze({
        status: "COMPLETE",
        message: "0.01 SOL live lifecycle canary completed: BUY confirmed, 25-second minimum hold satisfied, CLOSE confirmed, broker account flat. Automatic grid execution is still OFF.",
        openPrice: opened.fillPrice,
        closePrice: closed.fillPrice,
        quantity: closeQuantity
      });
    } finally {
      busy = false;
    }
  }

  return Object.freeze({ run, quantity: CANARY_QUANTITY, openCode: OPEN_CODE, closeCode: CLOSE_CODE });
}
