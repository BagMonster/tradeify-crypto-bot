const PROFILES = Object.freeze({
  "BTC/USD": Object.freeze({
    asset: "BTC",
    dxtradeSymbol: "BTC/USD",
    binanceSymbol: "BTCUSDT",
    binanceStream: "btcusdt@trade"
  }),
  "SOL/USD": Object.freeze({
    asset: "SOL",
    dxtradeSymbol: "SOL/USD",
    binanceSymbol: "SOLUSDT",
    binanceStream: "solusdt@trade",
    lotStep: 0.01
  }),
  "DOGE/USD": Object.freeze({
    asset: "DOGE",
    dxtradeSymbol: "DOGE/USD",
    binanceSymbol: "DOGEUSDT",
    binanceStream: "dogeusdt@trade",
    lotStep: 0.01
  }),
  "ZEC/USD": Object.freeze({
    asset: "ZEC",
    dxtradeSymbol: "ZEC/USD",
    binanceSymbol: "ZECUSDT",
    binanceStream: "zecusdt@trade",
    lotStep: 0.01
  }),
  "AAVE/USD": Object.freeze({
    asset: "AAVE",
    dxtradeSymbol: "AAVE/USD",
    binanceSymbol: "AAVEUSDT",
    binanceStream: "aaveusdt@trade",
    lotStep: 0.01
  }),
  "AVAX/USD": Object.freeze({
    asset: "AVAX",
    dxtradeSymbol: "AVAX/USD",
    binanceSymbol: "AVAXUSDT",
    binanceStream: "avaxusdt@trade",
    lotStep: 0.01
  })
});

export function resolveInstrumentProfile(strategy) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
    throw new TypeError("strategy configuration must be an object");
  }
  const instruments = strategy.instruments;
  if (!instruments || typeof instruments !== "object" || Array.isArray(instruments)) {
    throw new TypeError("strategy.instruments must be an object");
  }

  const enabled = Object.entries(instruments)
    .filter(([, config]) => config?.enabled === true)
    .map(([symbol]) => symbol);

  if (enabled.length !== 1) {
    throw new Error("exactly one trading instrument must be enabled");
  }

  const profile = PROFILES[enabled[0]];
  if (!profile) throw new Error(`unsupported enabled instrument: ${enabled[0]}`);
  return profile;
}

export function getSupportedInstrumentProfile(dxtradeSymbol) {
  const profile = PROFILES[dxtradeSymbol];
  if (!profile) throw new Error(`unsupported instrument: ${dxtradeSymbol}`);
  return profile;
}

export const SUPPORTED_INSTRUMENT_PROFILES = PROFILES;
