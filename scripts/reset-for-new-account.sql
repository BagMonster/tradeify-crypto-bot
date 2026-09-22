-- scripts/reset-for-new-account.sql
--
-- Clears the previous Tradeify account's state so the bot starts clean on a new
-- account. Run it in the Railway Postgres service's query view (or psql),
-- with the trading worker STOPPED. Full procedure: docs/launch-checklist-10k.md.
--
-- What it does, in ONE transaction (all or nothing):
--   1. Refuses to run if the trading bot wrote its deadman heartbeat in the last
--      2 minutes, i.e. if the bot is still running.
--   2. Copies every table it is about to clear into a new schema named
--      archive_<UTC timestamp>, so nothing is lost.
--   3. Clears the account-specific state:
--        bot_state              balance, the old PEAK balance, max-loss floor, halts.
--                               Rebuilt from the active profile on the next boot.
--        sol_risk_ladder_state  each day's starting balance. A stale row for today
--                               would trigger a D-049 baseline-mismatch halt.
--        daily_ledger           realised P&L per day
--        session_harvest_state  harvest status per day
--        halt_warning_cycle     pending halt countdowns
--        hybrid_watermark       the reconciler's position in the OLD account's orders
--
-- Deliberately KEPT: ring_grid_state (all books flat; ring sizes are rebuilt from the
-- profile; version numbers keep order codes unique), the order ledger and sent-alert
-- history (audit trail; keys stay unique), events, bars, dev-companion tables and
-- bot_liveness.
--
-- Safe to re-run: each run archives into its own new schema.

DO $$
DECLARE
  archive_schema TEXT := 'archive_' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDD_HH24MISS');
  tbl TEXT;
  copied BIGINT;
  report TEXT := '';
BEGIN
  -- 1. The bot must be stopped.
  IF to_regclass('public.bot_liveness') IS NOT NULL
     AND EXISTS (SELECT 1 FROM bot_liveness WHERE written_at > NOW() - INTERVAL '2 minutes') THEN
    RAISE EXCEPTION 'The trading bot is still running (deadman heartbeat written in the last 2 minutes). Stop the trading worker in Railway, wait 2 minutes, then run this again. Nothing was changed.';
  END IF;

  -- 2. Archive, then 3. clear.
  EXECUTE format('CREATE SCHEMA %I', archive_schema);
  FOREACH tbl IN ARRAY ARRAY[
    'bot_state', 'sol_risk_ladder_state', 'daily_ledger',
    'session_harvest_state', 'halt_warning_cycle', 'hybrid_watermark'
  ] LOOP
    IF to_regclass('public.' || tbl) IS NULL THEN
      report := report || format('%s: not present, skipped; ', tbl);
      CONTINUE;
    END IF;
    EXECUTE format('CREATE TABLE %I.%I AS TABLE public.%I', archive_schema, tbl, tbl);
    GET DIAGNOSTICS copied = ROW_COUNT;
    EXECUTE format('DELETE FROM public.%I', tbl);
    report := report || format('%s: %s rows archived and cleared; ', tbl, copied);
  END LOOP;

  RAISE NOTICE 'Reset complete. Archive schema: %. %', archive_schema, report;
END
$$;

-- After the next boot, confirm the rebuilt account state (expect the new profile's
-- starting balance, e.g. 10000.00 / 10000.00 / 9400.00 for the 10k profile):
--
--   SELECT balance, high_water, mll_floor, safety_halt, operator_killed FROM bot_state;
