#!/usr/bin/env node
/**
 * scripts/discover-accounts.mjs
 * Read-only: login + getUser, print account-related fields only.
 */
import "dotenv/config";
import { DxtradeReadOnlyClient } from "../src/dxtradeClient.js";

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

async function main() {
  const client = new DxtradeReadOnlyClient({
    restBaseUrl: requireEnv("DXTRADE_REST_BASE_URL"),
    marketDataUrl: requireEnv("DXTRADE_MARKETDATA_WS_URL"),
    username: requireEnv("DXTRADE_USERNAME"),
    domain: requireEnv("DXTRADE_DOMAIN"),
    password: requireEnv("DXTRADE_PASSWORD")
  });

  console.log("Logging in...");
  await client.login();
  console.log("Logged in.\n");

  try {
    const username = requireEnv("DXTRADE_USERNAME");
    console.log("Calling getUser()...");
    const user = await client.getUser(username);

    // Print only structure / keys — avoid dumping secrets if any appear
    console.log("\nRaw getUser response (redact anything sensitive before sharing):");
    console.log(JSON.stringify(user, null, 2));
  } catch (err) {
    console.log(`getUser failed: ${err.message}`);
  } finally {
    await client.logout();
    console.log("\nLogged out.");
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

