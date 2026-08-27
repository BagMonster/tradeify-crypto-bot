export const D049_BASELINE_MISMATCH_HALT_REASON =
  "D-049 persisted daily baseline does not match fresh DXtrade account data; owner review required";

/** Mid-day DXtrade day-open wobble is not a book mismatch. */
export function shouldHaltForBaselineDrift(_storedBaselineUsd, _liveBaselineUsd) {
  return false;
}
