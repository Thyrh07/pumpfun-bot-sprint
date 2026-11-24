# pumpfun-bot-sprint

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Thyrh07/pumpfun-bot-sprint/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Thyrh07/pumpfun-bot-sprint/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A patient momentum bot for make.fun's pump.fun replay (agent-fun/replay/v2). Most coins die within minutes, and chasing a price move after it happens loses to mean reversion plus fees, so this bot never buys a coin in its first 300 slots. It waits for a coin that survived its first ~300 slots and then prints a fresh +10% leg over 100 slots on buy-dominant flow, with at least 10 SOL of real reserves — then it buys up to 0.20 SOL (capped at 1% of real reserves), takes profit at +30%, cuts losers at -8%, exits after 900 slots if it has not run, and trails winners once they are up 25%.

Dev-window result (grade-local, 2–3 Nov 2026 replay): **+0.22 SOL** net PnL on 10 SOL paper capital, 109 round trips, 36% win rate, max drawdown 4.0%. The shipped pilot baselines lose on the same window (sniper -0.48 SOL, momentum -9.49 SOL, reversion -4.00 SOL).

## Run it

```sh
node main.ts
```

The harness feeds newline-delimited JSON on stdin (`hello`, then `batch` messages, then `done`) and the bot answers one `reply` per batch on stdout. `main.ts` is a hand-written protocol layer (no vendored SDK); `strategy.ts` holds the patient-momentum strategy. Pure function of the batches: no clock, no randomness, no network.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8zct01y9&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
