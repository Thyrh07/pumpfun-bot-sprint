// pumpfun-bot-sprint: a trading bot for make.fun's pump.fun replay (agent-fun/replay/v2).
//
// Hand-written protocol layer (no vendored SDK): the harness speaks newline-delimited
// JSON on stdin (hello, batch..., done) and the bot answers one reply per batch on
// stdout. The strategy lives in strategy.ts. A pure function of the batches it is
// fed: no clock, no randomness, no network, no I/O besides stdin/stdout.

import { createStrategy, DEFAULT_PARAMS, type Bot } from "./strategy.ts";

export const PROTOCOL = "agent-fun/replay/v2";
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS = 10_000n;

export type U64 = string;
export type Pubkey = string;

export interface Hello {
  type: "hello";
  protocol: string;
  seed: string;
  universe: unknown;
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

export interface Mark {
  mint: Pubkey;
  slot: number;
  virtual_token_reserves: U64;
  virtual_quote_reserves: U64;
  real_token_reserves: U64;
  real_quote_reserves: U64;
}

export interface TradeEvent {
  event: "TradeEvent";
  mint: Pubkey;
  sol_amount: U64;
  token_amount: U64;
  is_buy: boolean;
  user: Pubkey;
  timestamp: U64;
  virtual_sol_reserves: U64;
  virtual_token_reserves: U64;
  real_sol_reserves: U64;
  real_token_reserves: U64;
  creator: Pubkey;
  slot: number;
}

export interface CreateEvent {
  event: "CreateEvent";
  mint: Pubkey;
  creator: Pubkey;
  virtual_token_reserves: U64;
  virtual_sol_reserves: U64;
  real_token_reserves: U64;
  slot: number;
}

export interface CompleteEvent {
  event: "CompleteEvent";
  mint: Pubkey;
  slot: number;
}

export type ChainEvent = TradeEvent | CreateEvent | CompleteEvent;

export interface Fill {
  client_id: string;
  mint: Pubkey;
  side: "buy" | "sell";
  status: "filled" | "rejected" | "failed";
  reason: string | null;
  decided_slot: number;
  slot: number;
  quote_lamports: U64;
  token_amount: U64;
  fee_lamports: U64;
  tx_fee_lamports: U64;
  fee_fallback: boolean;
}

export interface Position {
  mint: Pubkey;
  token_amount: U64;
  cost_lamports: U64;
}

export interface Account {
  cash_lamports: U64;
  positions: Position[];
}

export interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: ChainEvent[];
  marks: Mark[];
  fills: Fill[];
  account: Account;
}

export interface Done {
  type: "done";
  seq: number;
  reason: "end_of_data" | "aborted";
  account: Account;
}

export interface Curve {
  mint: Pubkey;
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

export interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

export interface PendingOrder {
  order: Order;
  seq: number;
  decided_slot: number;
}

export interface BuyOrder {
  side: "buy";
  client_id: string;
  mint: Pubkey;
  quote_lamports: U64;
  max_slippage_bps: number;
}

export interface SellOrder {
  side: "sell";
  client_id: string;
  mint: Pubkey;
  token_amount: U64;
  max_slippage_bps: number;
}

export type Order = BuyOrder | SellOrder;

export interface BuyInput {
  side: "buy";
  mint: Pubkey;
  quote_lamports: bigint | string | number;
  max_slippage_bps: number;
}

export interface SellInput {
  side: "sell";
  mint: Pubkey;
  token_amount: bigint | string | number;
  max_slippage_bps: number;
}

export type OrderInput = BuyInput | SellInput;

/** Everything the bot knows, kept current before each strategy callback. */
export class BotState {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  account: Account;
  cash: bigint;
  readonly positions = new Map<Pubkey, Holding>();
  readonly curves = new Map<Pubkey, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.account = { cash_lamports: hello.capital.lamports, positions: [] };
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    const id = `o${this.#next++}`;
    this.#used.add(id);
    return id;
  }

  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /** Most this batch's buys on the mint may spend together (1% of real reserves). */
  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === "buy") mints.add(p.order.mint);
    return mints.size;
  }

  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === "buy") free -= BigInt(p.order.quote_lamports);
    }
    return free;
  }

  /** Marginal price in SOL per token, from the latest virtual reserves. */
  price(mint: Pubkey): number | null {
    const c = this.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves === 0n) return null;
    return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
  }

  #setAccount(account: Account): void {
    this.account = account;
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      this.positions.set(p.mint, {
        token_amount: BigInt(p.token_amount),
        cost_lamports: BigInt(p.cost_lamports),
      });
    }
  }

  #curve(mint: Pubkey, slot: number): Curve {
    let c = this.curves.get(mint);
    if (c === undefined) {
      c = {
        mint,
        created_slot: null,
        virtual_token_reserves: 0n,
        virtual_quote_reserves: 0n,
        real_token_reserves: 0n,
        real_quote_reserves: 0n,
        reserves_slot: slot,
        trades: 0,
        complete: false,
      };
      this.curves.set(mint, c);
    }
    return c;
  }

  /** Fold a batch in: fills, account, marks, events (in that order). */
  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.#setAccount(batch.account);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.#curve(m.mint, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const c = this.#curve(e.mint, e.slot);
        c.created_slot = e.slot;
        c.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        c.virtual_quote_reserves = BigInt(e.virtual_sol_reserves);
        c.real_token_reserves = BigInt(e.real_token_reserves);
        c.reserves_slot = e.slot;
      } else if (e.event === "TradeEvent") {
        const c = this.#curve(e.mint, e.slot);
        if (c.created_slot === null) c.created_slot = e.slot;
        c.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        c.virtual_quote_reserves = BigInt(e.virtual_sol_reserves);
        c.real_token_reserves = BigInt(e.real_token_reserves);
        c.real_quote_reserves = BigInt(e.real_sol_reserves);
        c.reserves_slot = e.slot;
        c.trades += 1;
      } else if (e.event === "CompleteEvent") {
        const c = this.#curve(e.mint, e.slot);
        c.complete = true;
        c.reserves_slot = e.slot;
      }
    }
  }

  applyDone(done: Done): void {
    this.#setAccount(done.account);
  }

  toOrders(inputs: OrderInput[]): Order[] {
    const orders: Order[] = [];
    for (const input of inputs) {
      if (input.side === "buy") {
        const quote = BigInt(input.quote_lamports);
        if (quote <= 0n) continue;
        orders.push({
          side: "buy",
          client_id: this.clientId(),
          mint: input.mint,
          quote_lamports: quote.toString(),
          max_slippage_bps: input.max_slippage_bps,
        });
      } else {
        const amount = BigInt(input.token_amount);
        if (amount <= 0n) continue;
        orders.push({
          side: "sell",
          client_id: this.clientId(),
          mint: input.mint,
          token_amount: amount.toString(),
          max_slippage_bps: input.max_slippage_bps,
        });
      }
    }
    return orders;
  }

  recordOrders(orders: Order[]): void {
    for (const o of orders) {
      this.pending.set(o.client_id, { order: o, seq: this.seq, decided_slot: this.slot });
    }
  }
}

async function* readLines(input: NodeJS.ReadableStream): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      yield line;
    }
  }
  if (buffer.length > 0) yield buffer;
}

async function runBot(bot: Bot): Promise<void> {
  const encoder = new TextEncoder();
  let state: BotState | null = null;
  let lineNo = 0;
  for await (const line of readLines(process.stdin)) {
    lineNo++;
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as { type?: unknown };
    if (msg.type === "hello") {
      const hello = msg as unknown as Hello;
      if (hello.protocol !== PROTOCOL) {
        throw new Error(`the harness speaks ${hello.protocol}; this bot speaks ${PROTOCOL}`);
      }
      state = new BotState(hello);
      await bot.onHello?.(state);
    } else if (msg.type === "batch") {
      if (state === null) throw new Error(`line ${lineNo}: a batch before hello`);
      const batch = msg as unknown as Batch;
      state.applyBatch(batch);
      const orders = state.toOrders(await bot.onBatch(state, batch));
      if (orders.length > state.hello.caps.max_orders_per_batch) {
        throw new Error(`batch ${batch.seq}: ${orders.length} orders (max ${state.hello.caps.max_orders_per_batch})`);
      }
      const reply = { type: "reply", seq: batch.seq, orders };
      const text = JSON.stringify(reply);
      if (encoder.encode(text).byteLength > 65_536) {
        throw new Error(`batch ${batch.seq}: reply over 64 KiB`);
      }
      state.recordOrders(orders);
      process.stdout.write(`${text}\n`);
    } else if (msg.type === "done") {
      if (state === null) throw new Error(`line ${lineNo}: done before hello`);
      const done = msg as unknown as Done;
      state.applyDone(done);
      await bot.onDone?.(state, done);
      return;
    } else {
      throw new Error(`line ${lineNo}: unknown message type ${String(msg.type)}`);
    }
  }
  throw new Error(state === null ? "input ended before hello" : "input ended before done");
}

await runBot(createStrategy(DEFAULT_PARAMS));
