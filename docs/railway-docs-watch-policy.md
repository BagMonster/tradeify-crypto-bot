# Railway watch policy for docs-only chronicle merges

A chronicle squash-merge must not restart or redeploy the trading worker.

## Required trading-service setting

In the Railway service that runs `npm start` / `index.mjs`:

- Watch only application paths: `src/**`, `index.mjs`, `package.json`, `package-lock.json`, `config/**`, `Procfile`.
- Do **not** watch `docs/**`.

Root `railway.toml` encodes the same watch patterns. Confirm the trading service actually uses that file. If the dashboard overrides it, copy the patterns there.

The companion service may share the repo. It also should not restart on `docs/chronicle/**` alone. Deploy companion code changes explicitly when you intend to.

## Why

BMTB1’s autobiography is Markdown. Restarting a live SOL grid because a paragraph landed on `main` is the opposite of the control philosophy.
