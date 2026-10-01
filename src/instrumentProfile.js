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
  "INJ/USD": Object.freeze({
    asset: "INJ",
    dxtradeSymbol: "INJ/USD",
    binanceSymbol: "INJUSDT",
    binanceStream: "injusdt@trade",
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
  }),
  // PEPE, RUNE and SUI: DXtrade order tickets (2026-09-30) show 1 lot = 1 coin,
  // priced per coin, same basis as the live five. lotStep 0.01 matches them.
  "PEPE/USD": Object.freeze({
    asset: "PEPE",
    dxtradeSymbol: "PEPE/USD",
    binanceSymbol: "PEPEUSDT",
    binanceStream: "pepeusdt@trade",
    lotStep: 0.01
  }),
  "RUNE/USD": Object.freeze({
    asset: "RUNE",
    dxtradeSymbol: "RUNE/USD",
    binanceSymbol: "RUNEUSDT",
    binanceStream: "runeusdt@trade",
    lotStep: 0.01
  }),
  "SUI/USD": Object.freeze({
    asset: "SUI",
    dxtradeSymbol: "SUI/USD",
    binanceSymbol: "SUIUSDT",
    binanceStream: "suiusdt@trade",
    lotStep: 0.01
  }),
  // HBAR, FLOKI and CHZ: DXtrade order tickets (2026-10-01) show 1 lot = 1 coin,
  // priced per coin, same basis as the other books. lotStep 0.01 matches them.
  "HBAR/USD": Object.freeze({
    asset: "HBAR",
    dxtradeSymbol: "HBAR/USD",
    binanceSymbol: "HBARUSDT",
    binanceStream: "hbarusdt@trade",
    lotStep: 0.01
  }),
  "FLOKI/USD": Object.freeze({
    asset: "FLOKI",
    dxtradeSymbol: "FLOKI/USD",
    binanceSymbol: "FLOKIUSDT",
    binanceStream: "flokiusdt@trade",
    lotStep: 0.01
  }),
  "CHZ/USD": Object.freeze({
    asset: "CHZ",
    dxtradeSymbol: "CHZ/USD",
    binanceSymbol: "CHZUSDT",
    binanceStream: "chzusdt@trade",
    lotStep: 0.01
  }),
  // 1INCH, ATOM, ALGO, BNB and CAKE: owner confirmed (2026-10-01) DXtrade quotes them
  // per coin with 1 lot = 1 coin, the same basis as the other books.,
  "1INCH/USD": Object.freeze({
    asset: "1INCH",
    dxtradeSymbol: "1INCH/USD",
    binanceSymbol: "1INCHUSDT",
    binanceStream: "1inchusdt@trade",
    lotStep: 0.01
  }),
  "ATOM/USD": Object.freeze({
    asset: "ATOM",
    dxtradeSymbol: "ATOM/USD",
    binanceSymbol: "ATOMUSDT",
    binanceStream: "atomusdt@trade",
    lotStep: 0.01
  }),
  "ALGO/USD": Object.freeze({
    asset: "ALGO",
    dxtradeSymbol: "ALGO/USD",
    binanceSymbol: "ALGOUSDT",
    binanceStream: "algousdt@trade",
    lotStep: 0.01
  }),
  "BNB/USD": Object.freeze({
    asset: "BNB",
    dxtradeSymbol: "BNB/USD",
    binanceSymbol: "BNBUSDT",
    binanceStream: "bnbusdt@trade",
    lotStep: 0.01
  }),
  "CAKE/USD": Object.freeze({
    asset: "CAKE",
    dxtradeSymbol: "CAKE/USD",
    binanceSymbol: "CAKEUSDT",
    binanceStream: "cakeusdt@trade",
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
