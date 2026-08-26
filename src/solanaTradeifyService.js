import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { calculateAccountFloors } from "./risk/accountRules.js";
import { accountDayKey } from "./risk/dailyRiskLadder.js";
import { createTradeifyService } from "./tradeifyService.js";
import { GRID_DEFINITION, expectedNetUnits, grossVirtualExposureUsd } from "./strategies/solanaGrid.js";
import { buildSolanaRingLevels, summarizeSolanaRingPosition } from "./monitoring/solanaRingQueries.js";
import { describeVirtualBook, resetVirtualInventoryToEmpty } from "./state/solanaReconcile.js";

function money(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(value);
}

function price(value) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function signedMoney(value) {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function signedPct(value) {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function ringStateLabel(ring) {
  if (!ring) return "STATE UNKNOWN";
  const count = Array.isArray(ring.lots) ? ring.lots.length : 0;
  if (count >= GRID_DEFINITION.perRing) return `FULL ${GRID_DEFINITION.perRing}/${GRID_DEFINITION.perRing}`;
  if (ring.armed) return count > 0 ? `ARMED ${count}/${GRID_DEFINITION.perRing}` : "ARMED";
  return count > 0 ? `DISARMED ${count}/${GRID_DEFINITION.perRing}` : "DISARMED";
}

function ladderStatusLines(ladder, equity) {
  const today = accountDayKey(Date.now());
  if (!ladder || ladder.dayKey !== today || !Number.isFinite(Number(ladder.baselineClosedBalanceUsd))) {
    return [
      "D-049 daily risk ladder: awaiting the first fresh DXtrade account snapshot for this account day."
    ];
  }
  const drawdown = Number(equity) - Number(ladder.baselineClosedBalanceUsd);
  return [
    `D-049 day baseline: ${money(ladder.baselineClosedBalanceUsd)}`,
    `D-049 current drawdown: ${signedMoney(drawdown)}`,
    `Entry brake (-$300): ${ladder.brakeEngaged ? "ACTIVE" : "READY"}`,
    `50% cut (-$1,000): ${ladder.partialCutDone ? "DONE" : "READY"}`,
    `Full flatten (-$1,250): ${ladder.flattenDone ? "DONE" : "READY"}`,
    `Halted until rollover: ${ladder.haltedForDay ? "YES" : "NO"}`
  ];
}

function hashReconcileCode(code, salt) {
  return createHash("sha256").update(`${salt}:reconcile:${code}`).digest("hex");
}

function safeHexEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createSolanaTradeifyService({
  database,
  account,
  strategy,
  environment,
  dxtradeClient,
  persistence,
  maProvider,
  execution,
  canary = null,
  getLiveMarketSnapshot = () => null
}) {
  const base = createTradeifyService({ database, account, strategy, environment, dxtradeClient });

  async function currentLadder() {
    if (typeof persistence?.getLatestRiskLadderState !== "function") return null;
    return persistence.getLatestRiskLadderState();
  }

  async function statusText() {
    const [botState, gridState, maState, ladder] = await Promise.all([
      database.getState(),
      persistence.state.load(),
      maProvider.getCurrent(),
      currentLadder()
    ]);
    const floors = calculateAccountFloors({
      startingBalance: account.startingBalance,
      maxLossOffset: account.maxLossOffset,
      peakClosedBalance: Math.max(account.startingBalance, botState.high_water),
      payoutTaken: botState.payout_taken,
      previousDayClosingBalance: botState.prev_day_close,
      dailyLossLimit: account.dailyLossLimit
    });
    const openLots = gridState?.rings.reduce((n, ring) => n + ring.lots.length, 0) ?? 0;
    const occupiedRings = gridState?.rings.filter((ring) => ring.lots.length > 0).length ?? 0;
    const armedRings = gridState?.rings.filter((ring) => ring.armed).length ?? 0;
    const ringCount = GRID_DEFINITION.activeLevelsPerSide * 2;
    const mark = maState.ma;
    const gross = gridState ? grossVirtualExposureUsd(gridState, mark) : 0;
    const net = gridState ? expectedNetUnits(gridState) : 0;
    const operating = botState.operator_killed || botState.safety_halt ? "PAUSED" : "RUNNING";
    const executionState = execution.isEnabled() ? "LIVE" : (strategy.execution.autoExecute ? "ARMED" : "LOCKED");

    const lines = [
      "TRADEIFY SOL OUTER-HEAVY STATUS",
      "",
      `Mode: ${environment.appMode.toUpperCase()} / PRODUCTION ${executionState}`,
      `Auto-execution: ${execution.isEnabled() ? "ON" : "OFF"}`,
      `Railway execution control: ${environment.autoExecute ? "ON" : "OFF"}`,
      `Strategy execution control: ${strategy.execution.autoExecute ? "ON" : "OFF"}`,
      `Bot: ${operating}`,
      "Strategy: sol-outer-heavy-v1 / D-049 resize",
      "Market source: Binance SOLUSDT",
      "Account source: DXtrade SOL/USD",
      "",
      `Balance: ${money(botState.balance)}`,
      `Live equity: ${money(botState.equity)}`,
      `Daily floor: ${money(floors.dailyFloor)}`,
      `MLL floor: ${money(floors.mllFloor)}`,
      `Active floor: ${money(floors.activeFloor)}`,
      `Floor buffer: ${money(botState.equity - floors.activeFloor)}`,
      `SOL broker position open: ${botState.has_open_position ? "YES" : "NO"}`,
      "",
      ...ladderStatusLines(ladder, botState.equity),
      "",
      `200-day MA: ${price(maState.ma)}`,
      `MA completed through: ${maState.completedThrough}`,
      `Virtual net SOL: ${net.toFixed(2)}`,
      `Virtual gross exposure @ MA: ${money(gross)} / ${money(GRID_DEFINITION.grossExposureCeilingUsd)}`,
      `Open virtual lots: ${openLots}`,
      `Occupied rings: ${occupiedRings}/${ringCount}`,
      `Armed rings: ${armedRings}/${ringCount}`,
      `SOL state version: ${gridState?.version ?? "N/A"}`,
      `Binance feed stale: ${botState.feed_stale ? "YES" : "NO"}`
    ];
    if (gridState?.lastFillAt) lines.push(`Last confirmed strategy fill: ${gridState.lastFillSide} @ ${price(gridState.lastFillPrice)} (${gridState.lastFillAt})`);
    if (botState.operator_killed) lines.push("Operator pause: ACTIVE");
    if (botState.safety_halt) lines.push(`Safety halt: ${botState.halt_reason ?? "Manual review required"}`);
    return lines.join("\n");
  }

  async function healthText() {
    const databaseTime = await database.ping();
    const ma = await maProvider.getCurrent();
    return [
      "Worker: OK",
      "PostgreSQL: OK",
      `Database time: ${new Date(databaseTime).toISOString()}`,
      "Instrument: SOL/USD / Binance SOLUSDT",
      "Strategy: sol-outer-heavy-v1 / D-049",
      `200-day MA: OK (${ma.completedThrough})`,
      `Auto-execution: ${execution.isEnabled() ? "ON" : "OFF"}`,
      `Mode: ${environment.appMode}`
    ].join("\n");
  }

  async function ringInputs() {
    const market = getLiveMarketSnapshot();
    if (!market || !Number.isFinite(Number(market.price)) || Number(market.price) <= 0) {
      return Object.freeze({ error: "SOL ring data unavailable: the live Binance SOLUSDT price has not been received yet." });
    }
    if (market.stale === true) {
      return Object.freeze({ error: "SOL ring data unavailable: the Binance SOLUSDT feed is stale. No level was guessed." });
    }
    const maState = await maProvider.getCurrent();
    if (!maState || !Number.isFinite(Number(maState.ma)) || Number(maState.ma) <= 0) {
      return Object.freeze({ error: "SOL ring data unavailable: the current completed-day 200-day MA is unavailable." });
    }
    return Object.freeze({ price: Number(market.price), ma: Number(maState.ma), maState, market });
  }

  async function ringLadderLines() {
    const [botState, ladder] = await Promise.all([database.getState(), currentLadder()]);
    return ladderStatusLines(ladder, botState.equity);
  }

  async function ringsText() {
    const inputs = await ringInputs();
    if (inputs.error) return inputs.error;
    const view = summarizeSolanaRingPosition({ price: inputs.price, ma: inputs.ma });
    const lines = [
      `SOL ${price(view.price)} | MA ${price(view.ma)}`,
      "",
      `Status: ${view.status}`
    ];

    if (view.touched) {
      lines.push(`${view.touched.tag} ${view.touched.status} @ ${price(view.touched.triggerPrice)}`);
      lines.push(`Size: ${money(view.touched.usd)}`);
      lines.push("");
    }

    if (view.nextBuy && view.nextBuyDistance) {
      lines.push(`Next BUY   ${price(view.nextBuy.triggerPrice)}  (${signedMoney(view.nextBuyDistance.dollars)} / ${signedPct(view.nextBuyDistance.pct)})`);
    } else {
      lines.push(`Next BUY   none below price (beyond BUY${GRID_DEFINITION.activeLevelsPerSide})`);
    }
    if (view.nextShort && view.nextShortDistance) {
      lines.push(`Next SHORT ${price(view.nextShort.triggerPrice)}  (${signedMoney(view.nextShortDistance.dollars)} / ${signedPct(view.nextShortDistance.pct)})`);
    } else {
      lines.push(`Next SHORT none above price (beyond SHORT${GRID_DEFINITION.activeLevelsPerSide})`);
    }
    if (view.closer) lines.push("", `Closer to ${view.closer}`);
    lines.push("", ...(await ringLadderLines()));
    return lines.join("\n");
  }

  async function levelsText() {
    const inputs = await ringInputs();
    if (inputs.error) return inputs.error;
    const gridState = await persistence.state.load();
    if (!gridState || !Array.isArray(gridState.rings)) {
      return "SOL level data unavailable: persistent grid state has not initialized.";
    }
    const levels = buildSolanaRingLevels({ ma: inputs.ma });
    const stateByTag = new Map(gridState.rings.map((ring) => [ring.tag, ring]));
    const lines = [
      "SOL GRID LEVELS",
      `SOL ${price(inputs.price)} | MA ${price(inputs.ma)}`,
      "",
      "BUY RINGS"
    ];

    for (const ring of levels.buys) {
      lines.push(`${ring.tag} ${price(ring.triggerPrice)} · ${money(ring.usd)} · ~${ring.estimatedUnitsAtTrigger.toFixed(2)} SOL · ${ringStateLabel(stateByTag.get(ring.engineTag))}`);
    }
    lines.push("", "SHORT RINGS");
    for (const ring of levels.shorts) {
      lines.push(`${ring.tag} ${price(ring.triggerPrice)} · ${money(ring.usd)} · ~${ring.estimatedUnitsAtTrigger.toFixed(2)} SOL · ${ringStateLabel(stateByTag.get(ring.engineTag))}`);
    }
    lines.push("", ...(await ringLadderLines()));
    lines.push("", "Trigger prices use Binance SOLUSDT. Actual DXtrade SOL/USD fills may differ slightly.");
    return lines.join("\n");
  }

  async function canaryText() {
    if (!canary || typeof canary.run !== "function") return "SOL live canary is unavailable in this worker.";
    const [botState, gridState] = await Promise.all([
      database.getState(),
      persistence.state.load()
    ]);
    const floors = calculateAccountFloors({
      startingBalance: account.startingBalance,
      maxLossOffset: account.maxLossOffset,
      peakClosedBalance: Math.max(account.startingBalance, botState.high_water),
      payoutTaken: botState.payout_taken,
      previousDayClosingBalance: botState.prev_day_close,
      dailyLossLimit: account.dailyLossLimit
    });

    if (botState.operator_killed) return "SOL live canary is blocked while the operator pause is active.";
    if (botState.safety_halt) return `SOL live canary is blocked by the safety halt: ${botState.halt_reason ?? "owner review required"}`;
    if (botState.has_open_position) return "SOL live canary requires the DXtrade account to be flat first.";
    if (botState.equity <= floors.activeFloor) return "SOL live canary is blocked because live equity is at or below the active account floor.";

    const result = await canary.run({ stateVersion: gridState?.version ?? 0 });
    if (result.status === "COMPLETE" && result.openPrice && result.closePrice) {
      return [
        "SOL LIVE CANARY COMPLETE",
        "",
        `Quantity: ${result.quantity.toFixed(2)} SOL`,
        `Open fill: ${price(result.openPrice)}`,
        `Close fill: ${price(result.closePrice)}`,
        "Broker account: FLAT",
        "Automatic grid execution: OFF",
        "",
        "The real DXtrade order lifecycle has been verified."
      ].join("\n");
    }
    return result.message ?? `SOL live canary ended with status ${result.status}.`;
  }

  async function requestReconcile() {
    const [botState, gridState] = await Promise.all([
      database.getState(),
      persistence.state.load()
    ]);
    if (!gridState) return { code: null, message: "SOL grid state is not initialized. Reconcile is unavailable." };
    if (botState.has_open_position) {
      return {
        code: null,
        message: "Reconcile refused: DXtrade still shows an open SOL position. Flatten the broker first, then send /status."
      };
    }
    const book = describeVirtualBook(gridState);
    const code = String(randomInt(100000, 1000000));
    const salt = randomBytes(16).toString("hex");
    const hash = hashReconcileCode(code, salt);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await database.setResumeChallenge(hash, salt, expiresAt);
    await database.addEvent("WARN", "SOL_RECONCILE_REQUESTED", {
      source: "telegram",
      virtualNet: book.netUnits,
      openLots: book.openLots,
      occupiedRings: book.occupiedRings,
      stateVersion: book.version,
      brokerOpen: botState.has_open_position === true
    });
    return {
      code,
      message: [
        "AUDITED VIRTUAL RECONCILE",
        "",
        `Broker SOL position: ${botState.has_open_position ? "OPEN" : "FLAT"}`,
        `Virtual net: ${book.netUnits.toFixed(2)} SOL`,
        `Open virtual lots: ${book.openLots}`,
        `Occupied rings: ${book.occupiedRings.join(", ") || "none"}`,
        "",
        "This will empty virtual lots, rearm all 20 D-049 rings, write an audit event, and clear the reconciliation safety halt.",
        "It will NOT place a DXtrade order and will NOT remove the operator pause.",
        "After confirm, send /status. If the books match, then /resume.",
        "",
        `To apply, send /confirmreconcile ${code} within 10 minutes.`
      ].join("\n")
    };
  }

  async function confirmReconcile(code) {
    const [botState, gridState] = await Promise.all([
      database.getState(),
      persistence.state.load()
    ]);
    if (!/^\d{6}$/.test(code ?? "")) return "Use /confirmreconcile followed by the 6-digit code from /reconcile.";
    if (!botState.resume_code_hash || !botState.resume_code_salt || !botState.resume_code_expires_at) {
      return "No reconcile request is pending. Send /reconcile first.";
    }
    if (new Date(botState.resume_code_expires_at).getTime() < Date.now()) {
      await database.clearResumeChallenge();
      return "That reconcile code expired. Send /reconcile for a new code.";
    }
    const suppliedHash = hashReconcileCode(code, botState.resume_code_salt);
    if (!safeHexEqual(suppliedHash, botState.resume_code_hash)) {
      await database.addEvent("WARN", "SOL_RECONCILE_CODE_REJECTED", { source: "telegram" });
      return "The reconcile code is incorrect. A /resume code will not work here.";
    }
    if (botState.has_open_position) {
      await database.clearResumeChallenge();
      return "Reconcile aborted: DXtrade now shows an open SOL position. Flatten the broker first.";
    }
    if (!gridState) {
      await database.clearResumeChallenge();
      return "Reconcile aborted: SOL grid state is missing.";
    }

    const before = describeVirtualBook(gridState);
    const next = resetVirtualInventoryToEmpty(gridState);
    await persistence.state.save(gridState.version, next);
    if (typeof database.clearSafetyHalt === "function") await database.clearSafetyHalt();
    await database.clearResumeChallenge();
    const after = describeVirtualBook(next);
    await database.addEvent("WARN", "SOL_VIRTUAL_RECONCILE_APPLIED", {
      source: "telegram",
      reason: "owner-audited flatten after manual broker close",
      before,
      after
    });
    return [
      "AUDITED VIRTUAL RECONCILE APPLIED",
      "",
      `Previous virtual net: ${before.netUnits.toFixed(2)} SOL across ${before.openLots} lot(s)`,
      `New virtual net: ${after.netUnits.toFixed(2)} SOL`,
      `New open lots: ${after.openLots}`,
      `State version: ${gridState.version} → ${next.version}`,
      "Safety halt: cleared",
      "Operator pause: unchanged",
      "",
      "Send /status. If broker is still FLAT and virtual net is 0, then /resume."
    ].join("\n");
  }

  return Object.freeze({
    ...base,
    statusText,
    healthText,
    ringsText,
    levelsText,
    canaryText,
    requestReconcile,
    confirmReconcile
  });
}
