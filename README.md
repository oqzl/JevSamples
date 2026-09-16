# JevSamples

Experiments that use TypeSafe Jev as a machine-native intelligence primitive.

## Backtest: JRA historical prediction

`backtest/jra/` tests Jev against the Kaggle JRA historical dataset without committing the dataset itself. The default benchmark anonymizes identities and withholds current-race odds/popularity from model state to reduce memorization and market leakage. See [backtest/jra/README.md](backtest/jra/README.md).

## Demo: Jev World — Common Sense at 5s/turn

A small agent simulation where topology and natural-language context create behavior.

Every turn, the browser sends one structured world state to a Cloudflare Worker. The Worker builds 5 independent questions per agent and sends them to Jev in one `/v1/systemone` call:

- Choice: next action
- Choice: destination, asked speculatively in case the agent moves
- Choice: social target, asked speculatively in case the agent socializes
- Score: goal urgency
- Noul: whether the current situation contains an anomaly worth investigating

The UI exposes the returned probability distributions, confidence, score, token usage, latency, and estimated request cost. Code, not the model, owns world mutation.

### Why this shape

It deliberately demonstrates Jev's distinctive programming model:

- many atomic judgments in one parallel call
- speculative fan-out
- typed closed-set outputs
- probability distributions instead of generated prose
- optional confidence-gated execution
- natural-language world laws and interventions without changing the simulation code

## Run locally

1. Install Wrangler if needed.
2. Create a TypeSafe API key.
3. Run:

```sh
npx wrangler secret put TYPESAFE_API_KEY
npx wrangler dev
```

Open the local URL and press `STEP` or `START`.

## Deploy on Cloudflare Workers

The public directory is `web/`.

```sh
node scripts/stamp.mjs
npx wrangler deploy
```

For Workers Builds, use:

- Build command: `node scripts/stamp.mjs`
- Deploy command: `npx wrangler deploy`

Add the Worker secret:

```sh
npx wrangler secret put TYPESAFE_API_KEY
```

If the deployed demo is for personal use, protect it with Cloudflare Access. The Worker-side secret must not be exposed to browser JavaScript.

## Notes

- `web/` is the deployable static surface.
- Static asset URLs and the Service Worker cache use the deployment commit SHA.
- The Worker limits state size and agent/node counts and constructs the TypeSafe questions itself, so it is not a general-purpose API proxy.
- The displayed dollar estimate uses TypeSafe's published September 2026 input price of $42 per billion input tokens; check current pricing before treating it as accounting data.
