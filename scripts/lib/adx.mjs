/**
 * scripts/lib/adx.mjs
 *
 * Pure Wilder's Average Directional Index (ADX) implementation.
 * Reusable across research scripts.
 *
 * Returns an array of the same length as the input bars.
 * Early values are null until the indicator is fully warmed up.
 *
 * @param {Array<{high:number, low:number, close:number}>} bars
 * @param {number} period  - default 14
 * @returns {Array<number|null>}
 */
export function calculateADX(bars, period = 14) {
  const n = bars.length;
  const adx = new Array(n).fill(null);

  if (n < period * 2) return adx; // need enough bars for stable ADX

  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);

  // 1. True Range, +DM, -DM
  for (let i = 1; i < n; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevHigh = bars[i - 1].high;
    const prevLow = bars[i - 1].low;
    const prevClose = bars[i - 1].close;

    // True Range
    tr[i] = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );

    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // 2. First smoothed values (simple sum of first `period` values)
  let smoothTR = 0;
  let smoothPlusDM = 0;
  let smoothMinusDM = 0;

  for (let i = 1; i <= period; i++) {
    smoothTR += tr[i];
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
  }

  const dx = new Array(n).fill(null);

  // First DX
  let plusDI = smoothTR === 0 ? 0 : (100 * smoothPlusDM) / smoothTR;
  let minusDI = smoothTR === 0 ? 0 : (100 * smoothMinusDM) / smoothTR;
  const diSum = plusDI + minusDI;
  dx[period] = diSum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / diSum;

  // 3. Wilder smooth the rest and calculate DX
  for (let i = period + 1; i < n; i++) {
    smoothTR = smoothTR - smoothTR / period + tr[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];

    plusDI = smoothTR === 0 ? 0 : (100 * smoothPlusDM) / smoothTR;
    minusDI = smoothTR === 0 ? 0 : (100 * smoothMinusDM) / smoothTR;

    const sum = plusDI + minusDI;
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
  }

  // 4. First ADX = average of first `period` DX values
  let adxSum = 0;
  let dxCount = 0;
  for (let i = period; i < period * 2 && i < n; i++) {
    if (dx[i] != null) {
      adxSum += dx[i];
      dxCount += 1;
    }
  }
  if (dxCount === 0) return adx;

  adx[period * 2 - 1] = adxSum / dxCount;

  // 5. Subsequent ADX (Wilder smooth)
  for (let i = period * 2; i < n; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }

  return adx;
}

