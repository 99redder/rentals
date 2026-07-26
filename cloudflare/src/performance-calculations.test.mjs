import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anchoredInstitutionPerformance,
  mergeStockStickiesTransactions,
  modifiedDietzPerformance,
  stockStickiesAccountValues,
  stockStickiesExternalFlow,
} from './performance-calculations.js';

test('contributions and withdrawals are separated from investment gain', () => {
  const result = modifiedDietzPerformance(100, 125, [
    { date: '2026-04-01', subtype: 'deposit', amount: -20 },
    { date: '2026-06-01', subtype: 'withdrawal', amount: 10 },
    { date: '2026-06-15', subtype: 'dividend', amount: -5 },
  ], 2026, '2026-07-01');

  assert.equal(result.netExternalFlow, 10);
  assert.equal(result.externalFlowCount, 2);
  assert.equal(result.gain, 15);
  assert.ok(result.weightedCapital > 100);
  assert.ok(result.returnPercent > 12 && result.returnPercent < 15);
});

test('Plaid cash-direction signs convert to investor cash-flow signs', () => {
  assert.equal(stockStickiesExternalFlow({ subtype: 'contribution', amount: -250 }), 250);
  assert.equal(stockStickiesExternalFlow({ subtype: 'distribution', amount: 100 }), -100);
  assert.equal(stockStickiesExternalFlow({ subtype: 'dividend', amount: -12 }), null);
});

test('manual reconciliation replaces Plaid external flows without removing trades', () => {
  const plaid = [
    { id: 'buy-1', stockStickiesAccount: 'individual', subtype: 'buy', amount: 100 },
    { id: 'plaid-deposit', stockStickiesAccount: 'individual', subtype: 'deposit', amount: -500 },
    { id: 'roth-deposit', stockStickiesAccount: 'roth', subtype: 'deposit', amount: -1000 },
  ];
  const manual = [
    { id: 'manual-deposit', stockStickiesAccount: 'individual', subtype: 'deposit', amount: -500 },
    { id: 'manual-withdrawal', stockStickiesAccount: 'individual', subtype: 'withdrawal', amount: 200 },
  ];

  assert.deepEqual(
    mergeStockStickiesTransactions(plaid, manual).map(transaction => transaction.id),
    ['buy-1', 'roth-deposit', 'manual-deposit', 'manual-withdrawal']
  );
});

test('institution-reported performance rolls forward without treating later deposits as gains', () => {
  const result = anchoredInstitutionPerformance(
    1561.47,
    13173.692,
    14273.692,
    [
      { date: '2026-07-27', subtype: 'deposit', amount: -500 },
      { date: '2026-07-27', subtype: 'dividend', amount: -25 },
    ],
    '2026-07-26',
    '2026-07-27'
  );

  assert.ok(Math.abs(result.gain - 2161.47) < 0.000001);
  assert.equal(result.valueChangeAfterAnchor, 1100);
  assert.equal(result.netExternalFlowAfterAnchor, 500);
  assert.equal(result.externalFlowCountAfterAnchor, 1);
});

test('account balances win over holdings without dropping fallback-only accounts', () => {
  const values = stockStickiesAccountValues({
    accounts: [
      { accountId: 'taxable', stockStickiesAccount: 'individual', currentBalance: 1000 },
      { accountId: 'roth', stockStickiesAccount: 'roth', currentBalance: null },
    ],
    positions: [
      { accountId: 'taxable', stockStickiesAccount: 'individual', institutionValue: 800 },
      { accountId: 'crypto', stockStickiesAccount: 'individual', institutionValue: 50 },
      { accountId: 'roth', stockStickiesAccount: 'roth', institutionValue: 400 },
    ],
  });

  assert.deepEqual(values, {
    individual: 1050,
    traditional: 0,
    roth: 400,
  });
});
