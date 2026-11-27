type Row = Record<string, unknown>;

// Both an account proof and the latest public recheck must still permit the same ordinary deposit.
export function bitgetDepositMinimum(coin: Row, network: Row): string | undefined {
  if (coin.transfer !== 'true' || network.rechargeable !== 'true' || network.needTag !== 'false' || network.congestion !== 'normal') return;
  for (const row of [coin, network]) {
    for (const field of ['depositFee', 'extraDepositFee']) {
      const fee = row[field];
      if (Object.hasOwn(row, field) && !(typeof fee === 'string' && /^0(?:\.0{1,18})?$/.test(fee))) return;
    }
  }
  const minimum = network.minDepositAmount;
  if (typeof minimum === 'string' && /^(?:0|[1-9]\d{0,59})(?:\.\d{1,18})?$/.test(minimum)) return minimum;
}
