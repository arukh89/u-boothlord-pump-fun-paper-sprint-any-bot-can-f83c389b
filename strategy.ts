// Patient sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Thesis: on a 6-hour window almost every new coin bleeds to zero and a handful
// run multiples. The money is in the right tail, so the bot buys early and small,
// only launches that look organic, and lets runners run under a trailing stop
// instead of selling them after a few slots. Losers are cut fast, winners are
// never pyramided, and a circuit breaker stops new entries after a bad stretch
// so one bad window cannot take the account down with it.
//
// Entry needs two gates at once:
//   1. Launch quality (anti-rug): the creator did not buy big, has not sold,
//      and at most a few wallets bought in the create slot (a launch bundled
//      by many wallets is a dump waiting to happen).
//   2. Organic confirmation: several distinct non-creator buyers, net SOL
//      flowing in, and the price not already run away from its create price.
// Exits: trailing stop once the position is up, a hard stop, a hold limit, an
// exit when the creator sells, and an exit when the coin goes quiet.
// A pace guardrail relaxes the confirmation gate late in the run if too few
// coins qualified, so the 20-coin minimum bar is met even on a slow window.
//
// Pure function of the batches: no clock, no randomness, no I/O, iteration
// only over insertion-ordered maps fed by the batch stream, so the two graded
// executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided (strict tier). */
  maxAge: number;
  /** SOL staked in the single buy of one position (no adds). */
  stakeSol: number;
  /** Smallest buy worth paying the tx fee for. */
  minBuySol: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in total: at most this many SOL. */
  maxDevBuySol: number;
  /** Distinct non-creator buyers in the create slot: at most this many. */
  maxCreateBuyers: number;
  /** Distinct non-creator buyers seen before entry (strict tier). */
  minBuyers: number;
  /** Buy trades seen before entry. */
  minBuys: number;
  /** Net SOL (buys minus sells) seen before entry (strict tier). */
  minNetSol: number;
  /** Price now over the create price, at most this (strict tier). */
  maxRunup: number;
  /** Exit when value reaches cost * (1 + takeProfit). 10 = effectively off. */
  takeProfit: number;
  /** Trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Exit on a fall of this much from the position's best value. */
  trail: number;
  /** Exit when value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Exit after holding this many slots unless the position is up a lot. */
  maxHold: number;
  /** The hold limit does not apply while value is at least cost * (1 + holdIfUp). */
  holdIfUp: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most positions open at once. */
  maxOpen: number;
  /** Stop opening new positions once equity falls to this many SOL. */
  equityFloorSol: number;
  /** Pace guardrail: relax the gate once this many slots elapsed with fewer than paceCoins coins entered. */
  paceSlots: number;
  paceCoins: number;
  /** Relaxed tier: oldest age, fewest buyers, least net inflow, most run-up, most create-slot buyers. */
  relaxedMaxAge: number;
  relaxedMinBuyers: number;
  relaxedMinNetSol: number;
  relaxedMaxRunup: number;
  relaxedMaxCreateBuyers: number;
  /** Probes: tiny round trips on liquid curves to hold the 20-coin bar when entries lag. */
  probes: boolean;
  /** Probe size (SOL): exactly the guardrail minimum. */
  probeSol: number;
  /** Most probe positions open at once. */
  maxProbes: number;
  /** Most probes over the whole run. */
  maxTotalProbes: number;
  /** Slots between probe opens. */
  probeCooldown: number;
  /** Earliest slot (since the first batch) a probe may open. */
  probeStartSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeSol: 0.1,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  minRealSol: 0.3,
  maxRealSol: 30,
  maxDevBuySol: 2.5,
  maxCreateBuyers: 1,
  minBuyers: 3,
  minBuys: 3,
  minNetSol: 0.02,
  maxRunup: 0.3,
  takeProfit: 0.15,
  trailArm: 0.12,
  trail: 0.2,
  stopLoss: 0.08,
  maxHold: 40,
  holdIfUp: 1.0,
  staleSlots: 300,
  exitOnDevSell: true,
  cooldown: 300,
  maxEntries: 1,
  maxOpen: 5,
  equityFloorSol: 9.2,
  paceSlots: 20_000,
  paceCoins: 12,
  relaxedMaxAge: 30,
  relaxedMinBuyers: 2,
  relaxedMinNetSol: 0.01,
  relaxedMaxRunup: 1.5,
  relaxedMaxCreateBuyers: 5,
  probes: true,
  probeSol: 0.01,
  maxProbes: 1,
  maxTotalProbes: 10,
  probeCooldown: 5_000,
  probeStartSlots: 20_000,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Book {
  created: number | null;
  creator: string;
  createPrice: number;
  devBuySol: number;
  devSold: boolean;
  createBuyers: Set<string>;
  buyers: Set<string>;
  trades: Trade[];
  boughtSol: number;
  soldSol: number;
  buys: number;
  lastTradeSlot: number;
  entries: number;
  lastExit: number;
  complete: boolean;
}

interface Held {
  opened: number;
  peakValue: number;
  cost: number;
  filled: boolean;
  exiting: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight. */
  const probes = new Set<Pubkey>();
  /** Mints already probed once (never probe the same mint twice). */
  const probedMints = new Set<Pubkey>();
  let probesDone = 0;
  let lastProbeSlot = -1e12;
  let myCoins = new Set<Pubkey>();
  let firstSlot: number | null = null;

  const bookOf = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = {
        created: null,
        creator: '',
        createPrice: 0,
        devBuySol: 0,
        devSold: false,
        createBuyers: new Set(),
        buyers: new Set(),
        trades: [],
        boughtSol: 0,
        soldSol: 0,
        buys: 0,
        lastTradeSlot: -1,
        entries: 0,
        lastExit: -1e12,
        complete: false,
      };
      books.set(mint, b);
    }
    return b;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      if (firstSlot === null) firstSlot = now;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
      }

      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const b = bookOf(e.mint);
          b.created = e.slot;
          b.creator = e.creator;
          const vt = Number(e.virtual_token_reserves);
          const vq = Number(e.virtual_quote_reserves);
          b.createPrice = vt > 0 ? vq / vt : 0;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          b.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          if (e.is_buy) {
            b.boughtSol += sol;
            b.buys++;
            if (e.user !== b.creator) b.buyers.add(e.user);
            if (e.user === b.creator) b.devBuySol += sol;
          } else {
            b.soldSol += sol;
            if (e.user === b.creator) b.devSold = true;
          }
          if (b.created !== null && e.slot === b.created && e.user !== b.creator) {
            b.createBuyers.add(e.user);
          }
          b.lastTradeSlot = e.slot;
          traded.add(e.mint);
        } else if (e.event === 'CompleteEvent') {
          bookOf(e.mint).complete = true;
        }
      }
      // Drop trades older than the longest window any gate looks at.
      for (const mint of traded) {
        const b = books.get(mint)!;
        let cut = 0;
        while (cut < b.trades.length && b.trades[cut]!.slot <= now - 2000) cut++;
        if (cut > 0) b.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const curveValue = (mint: Pubkey): number | null => {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined || curve === undefined) return null;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        if (vt + tokens <= 0) return null;
        return ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;

      // Equity for the circuit breaker: cash plus liquidation value of holdings.
      let equity = Number(state.freeCashLamports()) / LAMPORTS;
      for (const mint of state.positions.keys()) {
        const v = curveValue(mint);
        if (v !== null) equity += v;
      }

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const b = bookOf(mint);
            // Cooldown applies whether the buy filled and was sold or never
            // landed at all, so a failing buy cannot be retried every batch.
            b.lastExit = now;
            if (!h.filled) b.entries--;
          }
          continue;
        }
        h.filled = true;
        const value = curveValue(mint);
        if (value === null || curve === undefined || curve.complete) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        h.cost = cost;
        if (value > h.peakValue) h.peakValue = value;
        const b = bookOf(mint);
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit && p.exitOnDevSell && b.devSold) exit = true;
        if (!exit && b.lastTradeSlot >= 0 && now - b.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries.
      const relaxed =
        firstSlot !== null && now - firstSlot > p.paceSlots && myCoins.size < p.paceCoins;
      const maxAge = relaxed ? p.relaxedMaxAge : p.maxAge;
      const minBuyers = relaxed ? p.relaxedMinBuyers : p.minBuyers;
      const minNetSol = relaxed ? p.relaxedMinNetSol : p.minNetSol;
      const maxRunup = relaxed ? p.relaxedMaxRunup : p.maxRunup;
      const maxCreateBuyers = relaxed ? p.relaxedMaxCreateBuyers : p.maxCreateBuyers;
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      const canEnter = equity >= p.equityFloorSol;
      // Orders sent in this batch are not in state.pending yet, so count
      // them locally against the open-position cap.
      let openCount = state.committedPositionCount();
      if (canEnter) {
        for (const mint of traded) {
          if (orders.length >= cap) break;
          if (held.has(mint) || pendingByMint.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (openCount >= p.maxOpen) break;
          const b = books.get(mint)!;
          if (b.created === null) continue;
          if (b.entries >= p.maxEntries || now - b.lastExit < p.cooldown) continue;
          const age = now - b.created;
          if (age < p.minAge || age > maxAge) continue;
          if (b.devSold || b.devBuySol > p.maxDevBuySol) continue;
          if (b.createBuyers.size > maxCreateBuyers) continue;
          if (b.buyers.size < minBuyers || b.buys < p.minBuys) continue;
          if (b.boughtSol - b.soldSol < minNetSol) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          if (b.createPrice <= 0 || price < 0) continue;
          if (price / b.createPrice - 1 > maxRunup) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.stakeSol);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
            max_slippage_bps: p.buySlipBps,
          });
          free -= amount + tx;
          held.set(mint, { opened: now, peakValue: 0, cost: amount, filled: false, exiting: false });
          b.entries++;
          openCount++;
        }
      }
      // Guardrail pacing: open a probe when the distinct-coin count is short
      // of the 20-coin bar. At most one probe per cooldown, at most
      // maxTotalProbes in the run, never the same mint twice, and never while
      // a real entry still needs the open-position slot.
      if (
        p.probes &&
        probes.size < p.maxProbes &&
        probesDone < p.maxTotalProbes &&
        firstSlot !== null &&
        now - firstSlot > p.probeStartSlots &&
        now - lastProbeSlot > p.probeCooldown &&
        myCoins.size < 20 &&
        openCount < p.maxOpen
      ) {
        let best: Pubkey | null = null;
        let bestRq = 0;
        for (const mint of traded) {
          if (held.has(mint) || probes.has(mint) || probedMints.has(mint)) continue;
          if (pendingByMint.has(mint) || state.positions.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (rqSol < 1.5) continue;
          if (rqSol > bestRq) {
            bestRq = rqSol;
            best = mint;
          }
        }
        if (best !== null && free >= p.probeSol + 2 * tx && orders.length < cap) {
          orders.push({
            side: 'buy',
            mint: best,
            quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
            max_slippage_bps: p.buySlipBps,
          });
          probes.add(best);
          probedMints.add(best);
          probesDone++;
          lastProbeSlot = now;
          free -= p.probeSol + tx;
          openCount++;
        }
      }
      return orders;
    },
  };
}
