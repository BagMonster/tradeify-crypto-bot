import { createHash } from "node:crypto";

const FINAL_NONFILL = ["REJECTED", "CANCELED", "EXPIRED", "PARTIAL", "FAILED"];
const LOT_STEP = 0.01;
