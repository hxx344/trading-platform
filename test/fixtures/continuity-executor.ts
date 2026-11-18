// Separate execution process for the control outage test. Only the exchanges receive test inputs. All writes, timers
// and reconciliations run through the production executor and its normal run loop.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createExecutor } from '../../src/executor.ts';
import { runExecutor } from '../../src/runtime.ts';
import { createSimulatedVenues, SIM_BINDINGS, SIM_TRANSFER_PAIR } from '../../src/simulation.ts';
import { openStore } from '../../src/store.ts';

const [dir, socketPath, port, executionBuild] = process.argv.slice(2);
const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
// ADL and transfers intentionally use different accounts. On the same pair the engine interlocks their writes.
const adlPair = { id: 'adl-pair', mainAccountId: '0x' + 'd'.repeat(40), long: '0x' + 'e'.repeat(40), short: '0x' + 'f'.repeat(40) };
for (const side of [adlPair.long, adlPair.short]) {
  aster.openSubAccount(adlPair.mainAccountId, side, { available: '500' });
  asterTrading.openAccount(side);
}
asterTrading.setPosition(adlPair.long, 'BTCUSDT', 'LONG', '0.05');
asterTrading.setPosition(adlPair.short, 'BTCUSDT', 'SHORT', '-0.05');
asterTrading.inject({ operation: 'place', mode: 'rest' });

// Delay delivery of the already-dispatched transfer. Both its actual balance movement and its settlement must happen
// after the control process has exited. The connector still checks beforeSend and its signal upon delivery.
let deliver!: () => void;
const delivery = new Promise<void>(resolve => { deliver = resolve; });
const transfer = aster.transfer.bind(aster);
aster.transfer = async (...args) => { await delivery; return transfer(...args); };

const executor = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading,
  budgets: { callTimeoutMs: 60_000, adlCancelAfterMs: 60_000, adlQuerySpacingMs: 250, adlActiveQueryMs: 250 } });
assert.ok(executor.acquire());
for (const binding of SIM_BINDINGS) executor.registerAccount(binding);
executor.registerTransferPair(SIM_TRANSFER_PAIR);
executor.registerTransferPair(adlPair);

// These counters count arrivals at the matching engines, including duplicate sends the venues would reject.
function exchange() {
  return {
    pid: process.pid,
    arrivals: { lead: binance.arrived.place, hedge: bybit.arrived.place, transfer: aster.arrived.transfer, reduction: asterTrading.arrived.place },
    orderIds: [...binance.orders.keys(), ...bybit.orders.keys()],
    transfers: aster.ledger,
    balances: [aster.available(SIM_TRANSFER_PAIR.long), aster.available(SIM_TRANSFER_PAIR.short)],
    reductions: asterTrading.orders(adlPair.short),
    positions: [asterTrading.position(adlPair.long, 'BTCUSDT', 'LONG'), asterTrading.position(adlPair.short, 'BTCUSDT', 'SHORT')],
  };
}
export type ExchangeSnapshot = ReturnType<typeof exchange>;

runExecutor({ executor, store, dir, socketPath, port: Number(port), executionBuild, startedMessage: '模拟执行器', views: { status: () => ({ exchange: exchange() }) } });
process.on('message', message => {
  if (message === 'adl') asterTrading.adl(adlPair.long, 'BTCUSDT', 'LONG', '0.02');
  if (message === 'fill-and-deliver') {
    const [lead] = binance.orders.keys(), [reduction] = asterTrading.orders(adlPair.short);
    assert.ok(lead && reduction);
    binance.fillResting(lead, '1');
    asterTrading.fill(adlPair.short, reduction.clientOrderId);
    deliver();
  }
});
