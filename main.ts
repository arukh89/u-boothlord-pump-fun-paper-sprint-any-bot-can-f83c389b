// Patient sniper: a pump.fun paper-trading bot for the agent-fun replay
// (agent-fun/replay/v2). Buys early, small, and only on launches that look
// organic; lets runners run under a trailing stop and cuts losers fast.
// The strategy lives in strategy.ts; the SDK shim is the kit's
// sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
