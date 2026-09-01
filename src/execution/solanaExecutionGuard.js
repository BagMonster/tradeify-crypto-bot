import { createHash } from "node:crypto";

const FINAL_NONFILL = ["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"];
const LOT_STEP = 0.01;

function text(name, value, max = 128) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be non-empty`);
  const out = value.trim();
  if (out.length > max) throw new TypeError(`${name} is too long`);
  return out;
}

function positive(name, value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be positive`);
  return n;
}

function fixed8(value) {
  return Number(value.toFixed(8));
}

function floorLot(value) {
  return fixed8(Math.floor((value + 1e-9) / LOT_STEP) * LOT_STEP);
}

function orderCode(intent) {
  const suffix = intent.type === "ENTRY" ? "E" : `X${intent.tranche}`;
  return `SOLGRID-${intent.stateVersion}-${intent.tag}-${suffix}`;
}

// Deterministic, format-agnostic per-leg order-code suffix. Derived from the broker
// position code so it is stable across retries and worker restarts, and stable even
// when other legs of the same protective action have already closed. Fixed 12-hex
// length keeps every derived order code inside the 64-character order-code limit
// regardless of how long the broker's position codes turn out to be.
function legSuffix(code) {
  return createHash("sha256").update(code).digest("hex").slice(0, 12);
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
  const n = Number(position?.quantity ?? position?.qty);
  if (!Number.isFinite(n)) throw new Error("DXtrade SOL position quantity is invalid");
  return n;
}

function positionSide(position, quantity) {
  const raw = String(position?.side ?? position?.direction ?? "").toUpperCase();
  if (["SELL", "SHORT"].includes(raw)) return "SHORT";
  if (["BUY", "LONG"].includes(raw)) return "LONG";
  return quantity < 0 ? "SHORT" : "LONG";
}

function positionCode(position) {
  const code = position?.positionCode ?? position?.code ?? position?.id;
  return text("DXtrade position code", code == null ? "" : String(code), 128);
}

function compactDayKey(dayKey) {
  const key = text("dayKey", dayKey, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new TypeError("dayKey is invalid");
  return key.replaceAll("-", "");
}

function sameProtectiveOrder(row, { stateVersion, actionType, side, quantity, strategyId = "sol-outer-heavy-v1" }) {
  return row &&
    row.strategyId === strategyId &&
    row.instrument === "SOL/USD" &&
    row.stateVersion === stateVersion &&
    row.actionType === actionType &&
    row.side === side &&
    Math.abs(row.requestedQuantity - quantity) <= 1e-10;
}

// Distributes a requested aggregate cut quantity across the open broker legs in
// proportion to each leg's size, floored to the 0.01 SOL increment. Any shortfall
// created by flooring is redistributed one lot step at a time, largest-headroom
// first, with the position code breaking ties so the result is deterministic and
// reproducible after a restart.
function distributeCut(legs, requested) {
  const total = fixed8(legs.reduce((sum, leg) => sum + leg.quantity, 0));
  if (requested > total + 0.0050001) throw new Error("Protective cut quantity exceeds the total open SOL position");
  const target = Math.min(requested, total);

  const allocations = legs.map((leg) => ({
    leg,
    quantity: Math.min(floorLot(target * (leg.quantity / total)), leg.quantity)
  }));

  let shortfall = fixed8(target - allocations.reduce((sum, entry) => sum + entry.quantity, 0));
  const byHeadroom = [...allocations].sort((a, b) => {
    const diff = (b.leg.quantity - b.quantity) - (a.leg.quantity - a.quantity);
    if (Math.abs(diff) > 1e-12) return diff;
    return a.leg.positionCode < b.leg.positionCode ? -1 : 1;
  });

  let index = 0;
  while (shortfall >= LOT_STEP - 1e-9 && index < byHeadroom.length) {
    const entry = byHeadroom[index];
    if (fixed8(entry.leg.quantity - entry.quantity) >= LOT_STEP - 1e-9) {
      entry.quantity = fixed8(entry.quantity + LOT_STEP);
      shortfall = fixed8(shortfall - LOT_STEP);
      continue;
    }
    index += 1;
  }

  return allocations
    .filter((entry) => entry.quantity >= LOT_STEP - 1e-9)
    .map((entry) => Object.freeze({ ...entry.leg, cutQuantity: fixed8(entry.quantity) }));
}

function aggregateLegResults(results, orderCodes) {
  const filled = results.filter((result) => result.status === "FILLED");
  const failed = results.find((result) => result.status !== "FILLED");
  const filledQuantity = fixed8(filled.reduce((sum, result) => sum + (result.filledQuantity ?? 0), 0));
  const notional = filled.reduce((sum, result) => sum + (result.fillPrice ?? 0) * (result.filledQuantity ?? 0), 0);
  const filledAt = filled
    .map((result) => result.filledAt)
    .filter((value) => typeof value === "string")
    .sort()
    .at(-1) ?? null;

  return Object.freeze({
    status: failed ? failed.status : "FILLED",
    orderCode: orderCodes[0],
    orderCodes: Object.freeze([...orderCodes]),
    fillPrice: filledQuantity > 0 ? fixed8(notional / filledQuantity) : null,
    filledQuantity,
    filledAt,
    legs: Object.freeze(results.map((result) => Object.freeze({ ...result })))
  });
}

export function createSolanaExecutionGuard({
  autoExecute,
  strategyAutoExecute,
  adapter,
  client,
  persistence,
  protectiveOrdersBypassSlippageCap = true,
  addEvent = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  confirmationTimeoutMs = 12_000,
  pollIntervalMs = 750
}) {
  if (typeof autoExecute !== "boolean" || typeof strategyAutoExecute !== "boolean") throw new TypeError("execution locks must be boolean");
  if (typeof adapter?.place !== "function") throw new TypeError("SOL quantity adapter is invalid");
  if (typeof client?.getOpenPositions !== "function" || typeof client?.placePositionClose !== "function" ||
      typeof client?.placePositionPartialClose !== "function" || typeof client?.reconcileQuantityOrder !== "function") {
    throw new TypeError("SOL quantity client lacks protective-close methods");
  }
  if (typeof persistence?.claimOrder !== "function") throw new TypeError("SOL persistence is invalid");
  if (typeof protectiveOrdersBypassSlippageCap !== "boolean") throw new TypeError("protectiveOrdersBypassSlippageCap must be boolean");
  if (typeof addEvent !== "function") throw new TypeError("addEvent must be a function");
  if (typeof sleep !== "function") throw new TypeError("sleep must be a function");
  if (!Number.isFinite(confirmationTimeoutMs) || confirmationTimeoutMs < 0) throw new TypeError("confirmationTimeoutMs is invalid");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new TypeError("pollIntervalMs is invalid");

  const inFlight = new Set();

  function isEnabled() {
    return autoExecute && strategyAutoExecute;
  }

  // An ENTRY opens new exposure and correctly uses positionEffect OPEN.
  // An EXIT must reduce existing exposure. Sending it as an opposite-side OPEN order
  // does not close anything on a hedging account: it opens a second, opposing
  // position and leaves the original untouched. Exits therefore resolve the live
  // broker positions on the virtual lot's own side and close against them by
  // position code, which is the same mechanism the verified V2 canary used.
  async function executeEntryIntent(intent, code) {
    // One-sided-at-a-time enforcement. Holding a long and a short on the same
    // instrument simultaneously is prohibited by the funded-account rules, so an
    // entry is refused whenever any opposing position is already open.
    const wantedDirection = intent.side === "BUY" ? "LONG" : "SHORT";
    const read = await readAllSolPositions();
    if (!read.ok) {
      await addEvent("ERROR", "SOL_ENTRY_BLOCKED_ACCOUNT_DATA_UNAVAILABLE", {
        orderCode: code, ringTag: intent.ringTag, reason: read.reason
      });
      return Object.freeze({
        status: "ACCOUNT_DATA_UNAVAILABLE",
        orderCode: code,
        reason: `Cannot read the DXtrade book before entry: ${read.reason}`
      });
    }
    const opposing = read.legs.filter((leg) => leg.direction !== wantedDirection);
    if (opposing.length > 0) {
      await addEvent("ERROR", "SOL_ENTRY_BLOCKED_OPPOSING_POSITION", {
        orderCode: code,
        ringTag: intent.ringTag,
        entrySide: intent.side,
        opposingLegs: opposing.length,
        opposingQuantity: fixed8(opposing.reduce((sum, leg) => sum + leg.quantity, 0))
      });
      return Object.freeze({
        status: "BLOCKED",
        orderCode: code,
        reason: "An opposing SOL position is open; entering would hold both sides at once"
      });
    }

    const result = await adapter.place({
      orderCode: code,
      strategyId: intent.strategyId,
      instrument: "SOL/USD",
      stateVersion: intent.stateVersion,
      actionType: "ENTRY",
      ringTag: intent.ringTag,
      lotId: intent.lotId ?? null,
      tranche: null,
      side: intent.side,
      quantity: intent.quantity
    });
    if (result.confirmed !== true || result.status !== "FILLED") {
      await addEvent("WARN", "SOL_ORDER_NOT_CONFIRMED", { orderCode: code, status: result.status ?? "UNKNOWN" });
      return Object.freeze({ status: result.status ?? "NOT_CONFIRMED", orderCode: code });
    }
    return Object.freeze({ status: "FILLED", orderCode: code, ...result });
  }

  async function executeExitIntent(intent, code) {
    const wantedDirection = intent.virtualSide === "BUY" ? "LONG" : "SHORT";
    const read = await readAllSolPositions();
    if (!read.ok) {
      await addEvent("ERROR", "SOL_EXIT_BLOCKED_ACCOUNT_DATA_UNAVAILABLE", {
        orderCode: code, ringTag: intent.ringTag, lotId: intent.lotId, reason: read.reason
      });
      return Object.freeze({
        status: "ACCOUNT_DATA_UNAVAILABLE",
        orderCode: code,
        reason: `Cannot read the DXtrade book before exit: ${read.reason}`
      });
    }
    const all = read.legs;
    const legs = all.filter((leg) => leg.direction === wantedDirection);

    if (legs.length === 0) {
      await addEvent("ERROR", "SOL_EXIT_BLOCKED_NO_MATCHING_POSITION", {
        orderCode: code,
        ringTag: intent.ringTag,
        lotId: intent.lotId,
        tranche: intent.tranche,
        wantedDirection,
        openLegs: all.length
      });
      return Object.freeze({
        status: "BLOCKED",
        orderCode: code,
        reason: `No open ${wantedDirection} SOL position to close against`
      });
    }

    const available = fixed8(legs.reduce((sum, leg) => sum + leg.quantity, 0));
    if (intent.quantity > available + 1e-9) {
      await addEvent("ERROR", "SOL_EXIT_BLOCKED_QUANTITY_EXCEEDS_POSITION", {
        orderCode: code,
        lotId: intent.lotId,
        requested: intent.quantity,
        available
      });
      return Object.freeze({
        status: "BLOCKED",
        orderCode: code,
        reason: "Exit quantity exceeds the open broker position on that side"
      });
    }

    const allocations = [];
    let remaining = fixed8(intent.quantity);
    for (const leg of legs) {
      if (remaining < LOT_STEP - 1e-9) break;
      const take = fixed8(Math.min(leg.quantity, remaining));
      allocations.push({ leg, quantity: take });
      remaining = fixed8(remaining - take);
    }

    const results = [];
    const codes = [];
    for (const allocation of allocations) {
      const legCode = allocations.length === 1
        ? code
        : `${code}-${legSuffix(allocation.leg.positionCode)}`;
      codes.push(legCode);
      results.push(await closeOneLeg({
        code: legCode,
        leg: allocation.leg,
        quantity: allocation.quantity,
        actionType: "EXIT",
        reason: `SOL tranche exit ${intent.ringTag} T${intent.tranche}`,
        slippagePolicy: "GRID_EXIT",
        stateVersion: intent.stateVersion,
        strategyId: intent.strategyId,
        ringTag: intent.ringTag,
        lotId: intent.lotId ?? null,
        tranche: intent.tranche ?? null,
        // A tranche that consumes the whole broker position uses the verified
        // full-close path; anything smaller must reduce it by an explicit quantity.
        full: Math.abs(allocation.quantity - allocation.leg.quantity) <= 1e-9
      }));
    }

    return aggregateLegResults(results, codes);
  }

  async function executeIntent(intent) {
    if (!intent || (intent.type !== "ENTRY" && intent.type !== "EXIT")) throw new TypeError("SOL intent must be ENTRY or EXIT");
    const code = orderCode(intent);
    if (!isEnabled()) return Object.freeze({ status: "BLOCKED", orderCode: code, reason: "Automatic execution locks are off" });
    if (inFlight.has(code)) return Object.freeze({ status: "DUPLICATE_BLOCKED", orderCode: code });
    inFlight.add(code);
    try {
      await addEvent("INFO", "SOL_ORDER_SUBMITTING", {
        orderCode: code,
        actionType: intent.type,
        tag: intent.tag,
        tranche: intent.tranche ?? null,
        side: intent.side,
        quantity: intent.quantity,
        stateVersion: intent.stateVersion
      });

      const result = intent.type === "ENTRY"
        ? await executeEntryIntent(intent, code)
        : await executeExitIntent(intent, code);

      if (result.status !== "FILLED") return result;

      await addEvent("INFO", "SOL_ORDER_FILL_CONFIRMED", {
        orderCode: result.orderCode,
        actionType: intent.type,
        fillPrice: result.fillPrice,
        filledQuantity: result.filledQuantity,
        filledAt: result.filledAt
      });
      return result;
    } finally {
      inFlight.delete(code);
    }
  }

  // D-054: an unread DXtrade book is neither flat nor a mismatch. Every caller
  // must be able to distinguish "no positions" from "could not read positions",
  // so the read returns a result object rather than throwing. A thrown error here
  // would propagate out of executeIntent and be indistinguishable from a genuine
  // strategy fault.
  async function readAllSolPositions() {
    let payload;
    try {
      payload = await client.getOpenPositions();
    } catch (error) {
      return Object.freeze({ ok: false, reason: error?.message ?? "DXtrade positions read failed" });
    }
    try {
      return Object.freeze({ ok: true, legs: mapSolPositions(payload) });
    } catch (error) {
      return Object.freeze({ ok: false, reason: error?.message ?? "DXtrade positions payload is invalid" });
    }
  }

  function mapSolPositions(payload) {
    return positionRows(payload)
      .filter((row) => positionSymbol(row) === "SOL/USD" && Math.abs(positionQuantity(row)) > 1e-12)
      .map((row) => {
        const signedQty = positionQuantity(row);
        const direction = positionSide(row, signedQty);
        return Object.freeze({
          position: row,
          signedQty,
          direction,
          quantity: positive("protective broker quantity", Math.abs(signedQty)),
          closeSide: direction === "SHORT" ? "BUY" : "SELL",
          positionCode: positionCode(row)
        });
      })
      .sort((a, b) => (a.positionCode < b.positionCode ? -1 : a.positionCode > b.positionCode ? 1 : 0));
  }

  async function reconcileProtectiveClose({ code, quantity, reason, actionType, legPositionCode = null }) {
    const deadline = Date.now() + confirmationTimeoutMs;
    while (true) {
      const result = await client.reconcileQuantityOrder({ orderCode: code, requestedQuantity: quantity });
      if (result.status === "FILLED") {
        await persistence.markStatus(code, "FILLED", {
          fillPrice: result.fillPrice,
          filledQuantity: result.filledQuantity,
          filledAt: result.filledAt
        });
        await addEvent("WARN", actionType === "PROTECTIVE_CUT" ? "SOL_D049_PARTIAL_CUT_LEG_CONFIRMED" : "SOL_PROTECTIVE_FLATTEN_LEG_CONFIRMED", {
          reason,
          orderCode: code,
          legPositionCode,
          quantity,
          fillPrice: result.fillPrice,
          slippagePolicy: protectiveOrdersBypassSlippageCap ? "BYPASS" : "NOT_CONFIGURED"
        });
        return Object.freeze({ status: "FILLED", orderCode: code, legPositionCode, ...result });
      }
      if (FINAL_NONFILL.includes(result.status)) {
        await persistence.markStatus(code, result.status, { lastError: `Protective ${actionType} ended ${result.status}` });
        return Object.freeze({ status: result.status, orderCode: code, legPositionCode });
      }
      if (Date.now() >= deadline) {
        await persistence.markStatus(code, "PENDING", { lastError: `Protective ${actionType} confirmation timed out` });
        return Object.freeze({ status: "PENDING", orderCode: code, legPositionCode });
      }
      await sleep(pollIntervalMs);
    }
  }

  async function closeOneLeg({
    code, leg, quantity, actionType, reason, slippagePolicy, stateVersion, full,
    strategyId = "sol-outer-heavy-v1", ringTag = null, lotId = null, tranche = null
  }) {
    let row = await persistence.getOrder(code);
    if (!row) row = await persistence.claimOrder({
      orderCode: code,
      strategyId,
      instrument: "SOL/USD",
      stateVersion,
      actionType,
      ringTag,
      lotId,
      tranche,
      side: leg.closeSide,
      requestedQuantity: quantity
    });
    if (!sameProtectiveOrder(row, { stateVersion, actionType, side: leg.closeSide, quantity, strategyId })) {
      throw new Error(`Persistent ${actionType} order does not match the current request`);
    }
    if (row.status === "FILLED") return Object.freeze({
      status: "FILLED",
      orderCode: row.orderCode,
      legPositionCode: leg.positionCode,
      fillPrice: row.fillPrice,
      filledQuantity: row.filledQuantity,
      filledAt: row.filledAt
    });
    if (FINAL_NONFILL.includes(row.status)) {
      return Object.freeze({ status: row.status, orderCode: code, legPositionCode: leg.positionCode });
    }

    if (row.status === "CLAIMED") {
      await addEvent("WARN", actionType === "PROTECTIVE_CUT" ? "SOL_D049_PARTIAL_CUT_SUBMITTING" : "SOL_PROTECTIVE_FLATTEN_SUBMITTING", {
        orderCode: code,
        reason,
        legPositionCode: leg.positionCode,
        quantity,
        side: leg.closeSide,
        slippagePolicy
      });
      try {
        const response = full
          ? await client.placePositionClose({
              orderCode: code,
              orderSide: leg.closeSide,
              quantity,
              positionCode: leg.positionCode
            })
          : await client.placePositionPartialClose({
              orderCode: code,
              orderSide: leg.closeSide,
              quantity,
              positionCode: leg.positionCode
            });
        await persistence.markSubmitted(code, response?.orderId ?? null);
      } catch {
        await persistence.markStatus(code, "PENDING", { lastError: `Protective ${actionType} submission outcome is uncertain` });
      }
    }

    return reconcileProtectiveClose({
      code,
      quantity,
      reason,
      actionType,
      legPositionCode: leg.positionCode
    });
  }

  async function executeProtectiveCut({ stateVersion, dayKey, quantity, side, reason, bypassSlippageCap = true }) {
    text("reason", reason, 300);
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) throw new TypeError("stateVersion is invalid");
    const qty = positive("protective cut quantity", quantity);
    const requestedSide = text("protective cut side", side, 4).toUpperCase();
    if (requestedSide !== "BUY" && requestedSide !== "SELL") throw new TypeError("protective cut side must be BUY or SELL");
    if (bypassSlippageCap !== true || protectiveOrdersBypassSlippageCap !== true) {
      throw new Error("D-049 protective cut requires the approved slippage-cap bypass");
    }
    if (!isEnabled()) return Object.freeze({ status: "BLOCKED", reason: "Automatic execution locks are off" });

    const cutRead = await readAllSolPositions();
    if (!cutRead.ok) {
      await addEvent("ERROR", "SOL_D049_PARTIAL_CUT_ACCOUNT_DATA_UNAVAILABLE", { reason: cutRead.reason });
      return Object.freeze({ status: "ACCOUNT_DATA_UNAVAILABLE", reason: cutRead.reason });
    }
    const openLegs = cutRead.legs;
    if (openLegs.length === 0) return Object.freeze({ status: "ALREADY_FLAT" });
    if (openLegs.some((leg) => leg.closeSide !== requestedSide)) {
      await addEvent("ERROR", "SOL_D049_PARTIAL_CUT_SIDE_MISMATCH", {
        requestedSide,
        openSides: openLegs.map((leg) => leg.direction)
      });
      throw new Error("Protective cut side does not match every open SOL broker position");
    }

    const allocated = distributeCut(openLegs, qty);
    if (allocated.length === 0) return Object.freeze({ status: "BELOW_LOT_STEP", reason: "Requested cut floors below the 0.01 SOL increment" });

    const base = `SOLCUT-${compactDayKey(dayKey)}-${stateVersion}`;
    const results = [];
    const codes = [];
    for (const leg of allocated) {
      const code = `${base}-${legSuffix(leg.positionCode)}`;
      codes.push(code);
      results.push(await closeOneLeg({
        code,
        leg,
        quantity: leg.cutQuantity,
        actionType: "PROTECTIVE_CUT",
        reason,
        slippagePolicy: "BYPASS",
        stateVersion,
        full: false
      }));
    }

    const aggregate = aggregateLegResults(results, codes);
    await addEvent(aggregate.status === "FILLED" ? "WARN" : "ERROR", "SOL_D049_PARTIAL_CUT_CONFIRMED", {
      reason,
      status: aggregate.status,
      legCount: results.length,
      requestedQuantity: qty,
      filledQuantity: aggregate.filledQuantity,
      slippagePolicy: "BYPASS"
    });
    return aggregate;
  }

  async function executeProtectiveFlatten({ stateVersion, reason, dayKey = null, bypassSlippageCap = null }) {
    text("reason", reason, 300);
    if (!Number.isSafeInteger(stateVersion) || stateVersion < 0) throw new TypeError("stateVersion is invalid");
    const d049 = dayKey !== null;
    if (d049 && (bypassSlippageCap !== true || protectiveOrdersBypassSlippageCap !== true)) {
      throw new Error("D-049 protective flatten requires the approved slippage-cap bypass");
    }
    if (!isEnabled()) return Object.freeze({ status: "BLOCKED", reason: "Automatic execution locks are off" });

    const flatRead = await readAllSolPositions();
    if (!flatRead.ok) {
      await addEvent("ERROR", "SOL_PROTECTIVE_FLATTEN_ACCOUNT_DATA_UNAVAILABLE", { reason: flatRead.reason });
      return Object.freeze({ status: "ACCOUNT_DATA_UNAVAILABLE", reason: flatRead.reason });
    }
    const legs = flatRead.legs;
    if (legs.length === 0) return Object.freeze({ status: "ALREADY_FLAT" });

    if (legs.length > 1) {
      await addEvent("ERROR", "SOL_PROTECTIVE_FLATTEN_MULTI_POSITION", {
        legCount: legs.length,
        directions: legs.map((leg) => leg.direction),
        hedged: legs.some((leg) => leg.direction === "LONG") && legs.some((leg) => leg.direction === "SHORT")
      });
    }

    const base = d049 ? `SOLFLAT-${compactDayKey(dayKey)}-${stateVersion}` : `SOLFLAT-${stateVersion}`;
    const slippagePolicy = d049 ? "BYPASS" : "DIRECT_PROTECTIVE_CLOSE";
    const results = [];
    const codes = [];

    for (const leg of legs) {
      const code = `${base}-${legSuffix(leg.positionCode)}`;
      codes.push(code);
      results.push(await closeOneLeg({
        code,
        leg,
        quantity: leg.quantity,
        actionType: "PROTECTIVE_FLAT",
        reason,
        slippagePolicy,
        stateVersion,
        full: true
      }));
    }

    let aggregate = aggregateLegResults(results, codes);

    // A flatten is only a flatten if the account is actually flat afterwards. Every
    // leg reporting FILLED is not sufficient evidence on its own.
    if (aggregate.status === "FILLED") {
      const verify = await readAllSolPositions();
      if (!verify.ok) {
        await addEvent("ERROR", "SOL_PROTECTIVE_FLATTEN_NOT_VERIFIED", { reason: verify.reason });
        aggregate = Object.freeze({ ...aggregate, status: "NOT_VERIFIED" });
      } else if (verify.legs.length > 0) {
        const remaining = verify.legs;
        await addEvent("ERROR", "SOL_PROTECTIVE_FLATTEN_NOT_FLAT", {
          reason,
          remainingLegs: remaining.length,
          remainingQuantity: fixed8(remaining.reduce((sum, leg) => sum + leg.quantity, 0))
        });
        aggregate = Object.freeze({ ...aggregate, status: "NOT_FLAT" });
      }
    }

    await addEvent(aggregate.status === "FILLED" ? "WARN" : "ERROR", "SOL_PROTECTIVE_FLATTEN_CONFIRMED", {
      reason,
      status: aggregate.status,
      legCount: results.length,
      filledQuantity: aggregate.filledQuantity,
      slippagePolicy
    });
    return aggregate;
  }

  return Object.freeze({ isEnabled, executeIntent, executeProtectiveCut, executeProtectiveFlatten });
}
