import test from "node:test";
import assert from "node:assert/strict";
import { formatPrice } from "../src/format/price.js";

test("sub-cent prices use scientific notation instead of $0.00", () => {
  assert.equal(formatPrice(0.00000427), "$4.270e-6");
  assert.equal(formatPrice(0.0000033412), "$3.341e-6");
  assert.equal(formatPrice(0.0099), "$9.900e-3");
});

test("normal prices keep the existing currency style", () => {
  assert.equal(formatPrice(117.89), "$117.89");
  assert.equal(formatPrice(1.15785), "$1.1579");
  assert.equal(formatPrice(0.8012), "$0.8012");
  assert.equal(formatPrice(0.01), "$0.01");
  assert.equal(formatPrice(0), "$0.00");
});

test("non-finite prices are reported as unavailable", () => {
  assert.equal(formatPrice(Number.NaN), "unavailable");
  assert.equal(formatPrice(undefined), "unavailable");
});
