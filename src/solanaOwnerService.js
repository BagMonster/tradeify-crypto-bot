import { createSolanaTradeifyService } from "./solanaTradeifyService.js";
import { createRematchHandlers } from "./state/solanaRematch.js";

export function createSolanaOwnerService(opts) {
  return Object.freeze({
    ...createSolanaTradeifyService(opts),
    ...createRematchHandlers(opts)
  });
}
