export const STOCK_STICKIES_ACCOUNT_IDS = ['individual', 'traditional', 'roth'];

const EXTERNAL_FLOW_SUBTYPES = new Set([
  'contribution',
  'deposit',
  'distribution',
  'withdrawal',
]);

export function stockStickiesAccountValues(snapshot) {
  const values = Object.fromEntries(STOCK_STICKIES_ACCOUNT_IDS.map(id => [id, 0]));
  const accountIdsWithBalance = new Set();
  for (const account of Array.isArray(snapshot?.accounts) ? snapshot.accounts : []) {
    const id = account?.stockStickiesAccount;
    if (
      account?.currentBalance === null ||
      account?.currentBalance === undefined ||
      account?.currentBalance === ''
    ) continue;
    const currentBalance = Number(account?.currentBalance);
    if (!STOCK_STICKIES_ACCOUNT_IDS.includes(id) || !Number.isFinite(currentBalance)) continue;
    values[id] += currentBalance;
    accountIdsWithBalance.add(String(account.accountId || ''));
  }
  for (const position of Array.isArray(snapshot?.positions) ? snapshot.positions : []) {
    const id = position?.stockStickiesAccount;
    const value = Number(position?.institutionValue);
    if (
      !STOCK_STICKIES_ACCOUNT_IDS.includes(id) ||
      accountIdsWithBalance.has(String(position?.accountId || '')) ||
      !Number.isFinite(value)
    ) continue;
    values[id] += value;
  }
  return values;
}

export function isRecognizedExternalFlow(transaction) {
  return EXTERNAL_FLOW_SUBTYPES.has(transaction?.subtype);
}

export function stockStickiesExternalFlow(transaction) {
  if (!isRecognizedExternalFlow(transaction)) return null;
  const amount = Number(transaction?.amount);
  return Number.isFinite(amount) ? -amount : null;
}

export function modifiedDietzPerformance(openingValue, endingValue, transactions, year, endDate) {
  if (!Number.isFinite(openingValue) || !Number.isFinite(endingValue)) return null;
  const startMs = Date.parse(`${year}-01-01T12:00:00Z`);
  const endMs = Date.parse(`${endDate}T12:00:00Z`);
  const periodMs = Math.max(86_400_000, endMs - startMs);
  let netExternalFlow = 0;
  let weightedExternalFlow = 0;
  let externalFlowCount = 0;
  for (const transaction of transactions) {
    const flow = stockStickiesExternalFlow(transaction);
    const flowMs = Date.parse(`${transaction.date}T12:00:00Z`);
    if (flow === null || !Number.isFinite(flowMs) || flowMs < startMs || flowMs > endMs) continue;
    const weight = Math.max(0, Math.min(1, (endMs - flowMs) / periodMs));
    netExternalFlow += flow;
    weightedExternalFlow += flow * weight;
    externalFlowCount += 1;
  }
  const gain = endingValue - openingValue - netExternalFlow;
  const denominator = openingValue + weightedExternalFlow;
  return {
    gain,
    returnPercent: denominator > 0 ? (gain / denominator) * 100 : null,
    netExternalFlow,
    externalFlowCount,
  };
}
