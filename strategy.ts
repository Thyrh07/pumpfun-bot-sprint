// Patient momentum bot for make.fun's pump.fun replay (agent-fun/replay/v2).
//
// Idea, from offline analysis of the dev window (1,222 coins, 24h):
// most coins die within minutes and chasing a price move after it happens loses
// (mean reversion + 1.25% fees + tx fees eat the edge). The coins that survive
// their first ~300 slots and then print a fresh +10% leg on buy-dominant flow
// keep running more often than not, so this bot waits for that second leg and
// never buys a coin in its first 300 slots. It takes profit fast (+30%),
// cuts losers at -12%, never holds past 900 slots, and trails winners.
// A pure function of the batches it is fed: no clock, no randomness, no I/O.

import type { Batch, BotState, Done, OrderInput, Pubkey } from "./main.ts";

export interface Bot {
  onHello?(state: BotState): void | Promise<void>;
  onBatch(state: BotState, batch: Batch): OrderInput[] | Promise<OrderInput[]>;
  onDone?(state: BotState, done: Done): void | Promise<void>;
}

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Lookback (slots) for the momentum leg. */
  windowSlots: number;
  /** Price now over the price windowSlots ago, at least. */
  trigger: number;
  /** Minimum real SOL reserves at decision time. */
  minRealSol: number;
  /** Target buy size in SOL (still capped at 1% of real reserves). */
  sizeSol: number;
  /** Take profit: sell when the position is worth this multiple of entry. */
  tp: number;
  /** Stop loss: sell when the position is worth this multiple of entry. */
  sl: number;
  /** Hard hold cap (slots); exit after this long when below entry * 1.10. */
  maxHold: number;
  /** Trailing stop: once up this multiple, exit on a fall to peak * trailDrop. */
  trailArm: number;
  trailDrop: number;
  /** Slippage allowed on buys and sells (bps). */
  slippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 300,
  windowSlots: 100,
  trigger: 1.1,
  minRealSol: 10,
  sizeSol: 0.2,
  tp: 1.3,
  sl: 0.92,
  maxHold: 900,
  trailArm: 1.25,
  trailDrop: 0.85,
  slippageBps: 1000,
};

interface PricePoint {
  slot: number;
  price: number;
}

interface FlowTick {
  isBuy: boolean;
  sol: number;
}

interface Coin {
  mint: Pubkey;
  createSlot: number | null;
  /** (slot, price) observations, pruned to the recent past. */
  prices: PricePoint[];
  /** Last 20 trades, for the buy-dominance check. */
  recent: FlowTick[];
  entered: boolean;
}

interface Held {
  entryPrice: number;
  entrySlot: number;
  peak: number;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;

export function createStrategy(params: Params): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();

  function coinFor(mint: Pubkey): Coin {
    let c = coins.get(mint);
    if (c === undefined) {
      c = { mint, createSlot: null, prices: [], recent: [], entered: false };
      coins.set(mint, c);
    }
    return c;
  }

  /** Price at or before (slot - windowSlots), from the coin's observations. */
  function priceAgo(c: Coin, slot: number): number | null {
    const target = slot - params.windowSlots;
    let best: number | null = null;
    for (const p of c.prices) {
      if (p.slot <= target) best = p.price;
      else break;
    }
    return best;
  }

  return {
    onBatch(state, batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = state.slot;

      // Record fills first: a filled buy opens a tracked position.
      for (const f of batch.fills) {
        if (f.status !== "filled") continue;
        if (f.side === "buy") {
          const quote = Number(f.quote_lamports);
          const tokens = Number(f.token_amount);
          if (quote > 0 && tokens > 0) {
            const entryPrice = quote / tokens;
            held.set(f.mint, { entryPrice, entrySlot: f.slot, peak: entryPrice });
            coinFor(f.mint).entered = true;
          }
        }
      }
      // Drop tracked positions the harness no longer holds (sold / flattened / completed).
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) held.delete(mint);
      }

      // Update per-coin observations from this batch's events and marks.
      for (const e of batch.events) {
        const c = coinFor(e.mint);
        if (e.event === "CreateEvent") {
          c.createSlot = e.slot;
        } else if (e.event === "TradeEvent") {
          c.recent.push({ isBuy: e.is_buy, sol: Number(e.sol_amount) / Number(LAMPORTS_PER_SOL) });
          if (c.recent.length > 20) c.recent.shift();
        } else if (e.event === "CompleteEvent") {
          c.entered = true; // never buy a completed coin
        }
      }
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        const price = state.price(mint);
        if (price === null) continue;
        const c = coinFor(mint);
        if (c.createSlot === null && curve.created_slot !== null) c.createSlot = curve.created_slot;
        const last = c.prices[c.prices.length - 1];
        if (last === undefined || last.price !== price) {
          c.prices.push({ slot, price });
        }
        // Prune observations older than the lookback plus slack.
        while (c.prices.length > 0 && c.prices[0].slot < slot - params.windowSlots - 600) {
          c.prices.shift();
        }
      }

      // Exits for held positions.
      for (const [mint, pos] of held) {
        const price = state.price(mint);
        if (price === null) continue;
        if (price > pos.peak) pos.peak = price;
        const holding = state.positions.get(mint);
        if (holding === undefined || holding.token_amount === 0n) continue;
        let sell = false;
        if (price >= pos.entryPrice * params.tp) sell = true;
        else if (price <= pos.entryPrice * params.sl) sell = true;
        else if (slot - pos.entrySlot >= params.maxHold && price < pos.entryPrice * 1.1) sell = true;
        else if (pos.peak >= pos.entryPrice * params.trailArm && price <= pos.peak * params.trailDrop) sell = true;
        if (sell) {
          orders.push({
            side: "sell",
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: params.slippageBps,
          });
        }
      }

      // Entries: one per coin, only after minAge, on a fresh momentum leg.
      if (state.committedPositionCount() < state.hello.caps.max_open_positions) {
        for (const [mint, curve] of state.curves) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (curve.complete) continue;
          const c = coins.get(mint);
          if (c === undefined || c.entered) continue;
          if (c.createSlot === null) continue;
          const age = slot - c.createSlot;
          if (age < params.minAge) continue;
          if (state.positions.has(mint)) continue;
          if (state.pending.size > 0) {
            let pendingBuy = false;
            for (const p of state.pending.values()) {
              if (p.order.side === "buy" && p.order.mint === mint) pendingBuy = true;
            }
            if (pendingBuy) continue;
          }
          const price = state.price(mint);
          if (price === null) continue;
          const old = priceAgo(c, slot);
          if (old === null || price < old * params.trigger) continue;
          if (curve.real_quote_reserves < BigInt(params.minRealSol) * LAMPORTS_PER_SOL) continue;
          // Buy-dominant recent flow.
          let buyVol = 0;
          let sellVol = 0;
          for (const t of c.recent) {
            if (t.isBuy) buyVol += t.sol;
            else sellVol += t.sol;
          }
          if (c.recent.length > 0 && buyVol <= sellVol) continue;
          // Size: target, capped at 1% of real reserves and at free cash.
          const cap = state.maxBuyLamports(mint);
          let quote = BigInt(Math.floor(params.sizeSol * Number(LAMPORTS_PER_SOL)));
          if (quote > cap) quote = cap;
          const free = state.freeCashLamports() - state.txFeeLamports();
          if (quote > free) quote = free;
          if (quote < 10_000_000n) continue; // at least 0.01 SOL per round trip
          orders.push({ side: "buy", mint, quote_lamports: quote, max_slippage_bps: params.slippageBps });
          c.entered = true;
          if (state.committedPositionCount() + 1 >= state.hello.caps.max_open_positions) break;
        }
      }

      return orders;
    },
  };
}
