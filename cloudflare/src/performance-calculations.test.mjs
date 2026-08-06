import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateTimeWeightedReturn,
  anchoredInstitutionPerformance,
  buildStockStickiesCspLedger,
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
  assert.equal(stockStickiesExternalFlow({
    type: 'transfer',
    subtype: 'transfer',
    name: 'ACH deposit of $500 into Robinhood Brokerage account ending in 9903 - TRANSFER',
    amount: -500,
  }), 500);
  assert.equal(stockStickiesExternalFlow({
    type: 'transfer',
    subtype: 'transfer',
    name: 'ACH withdrawal of $200 from Robinhood Brokerage - TRANSFER',
    amount: 200,
  }), -200);
  assert.equal(stockStickiesExternalFlow({
    type: 'transfer',
    subtype: 'transfer',
    name: 'Internal account transfer',
    amount: -500,
  }), null);
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

test('manual reconciliation only replaces Plaid flows through its coverage date', () => {
  const plaid = [
    {
      id: 'covered-deposit',
      stockStickiesAccount: 'individual',
      date: '2026-06-29',
      type: 'transfer',
      subtype: 'transfer',
      name: 'ACH deposit of $10000 into Robinhood Brokerage - TRANSFER',
      amount: -10_000,
    },
    {
      id: 'new-deposit',
      stockStickiesAccount: 'individual',
      date: '2026-08-03',
      type: 'transfer',
      subtype: 'transfer',
      name: 'ACH deposit of $500 into Robinhood Brokerage - TRANSFER',
      amount: -500,
    },
  ];
  const manual = [{
    id: 'manual-covered-deposit',
    stockStickiesAccount: 'individual',
    date: '2026-06-23',
    subtype: 'deposit',
    amount: -10_000,
  }];

  assert.deepEqual(
    mergeStockStickiesTransactions(plaid, manual, { individual: '2026-07-24' })
      .map(transaction => transaction.id),
    ['new-deposit', 'manual-covered-deposit']
  );
});

test('a manual bridge flow is replaced when Plaid reports it after the coverage date', () => {
  const manualWithdrawal = {
    id: 'manual-withdrawal',
    stockStickiesAccount: 'individual',
    date: '2026-08-06',
    subtype: 'withdrawal',
    amount: 10_000,
  };
  const plaidWithdrawal = {
    id: 'delayed-plaid-withdrawal',
    stockStickiesAccount: 'individual',
    date: '2026-08-10',
    type: 'transfer',
    subtype: 'transfer',
    name: 'ACH withdrawal of $10000 from Robinhood Brokerage - TRANSFER',
    amount: 10_000,
  };

  const beforePlaid = mergeStockStickiesTransactions(
    [],
    [manualWithdrawal],
    { individual: '2026-07-24' }
  );
  assert.deepEqual(beforePlaid.map(transaction => transaction.id), ['manual-withdrawal']);

  const afterPlaid = mergeStockStickiesTransactions(
    [plaidWithdrawal],
    [manualWithdrawal],
    { individual: '2026-07-24' }
  );
  assert.deepEqual(afterPlaid.map(transaction => transaction.id), ['manual-withdrawal']);
  assert.equal(afterPlaid.reduce(
    (sum, transaction) => sum + stockStickiesExternalFlow(transaction),
    0
  ), -10_000);
});

test('manual bridge matching does not consume two same-value Plaid flows', () => {
  const manual = [{
    id: 'one-manual-deposit',
    stockStickiesAccount: 'individual',
    date: '2026-08-06',
    subtype: 'deposit',
    amount: -500,
  }];
  const plaid = [
    { id: 'deposit-one', stockStickiesAccount: 'individual', date: '2026-08-06', subtype: 'deposit', amount: -500 },
    { id: 'deposit-two', stockStickiesAccount: 'individual', date: '2026-08-07', subtype: 'deposit', amount: -500 },
  ];

  assert.deepEqual(
    mergeStockStickiesTransactions(plaid, manual, { individual: '2026-07-24' })
      .map(transaction => transaction.id),
    ['deposit-two', 'one-manual-deposit']
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

test('institution-reported performance does not treat a withdrawal as a loss', () => {
  const result = anchoredInstitutionPerformance(
    61_000,
    100_000,
    89_500,
    [{ date: '2026-08-06', subtype: 'withdrawal', amount: 10_000 }],
    '2026-08-05',
    '2026-08-06'
  );

  assert.equal(result.valueChangeAfterAnchor, -10_500);
  assert.equal(result.netExternalFlowAfterAnchor, -10_000);
  assert.equal(result.gain, 60_500);
});

test('all-account return weights account gains by their time-weighted capital', () => {
  const result = aggregateTimeWeightedReturn([
    { gain: 10, weightedCapital: 100 },
    { gain: 30, weightedCapital: 300 },
    { gain: -5, weightedCapital: 100 },
  ]);

  assert.ok(Math.abs(result - 7) < 0.000001);
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

test('CSP ledger matches opening premium to buy-to-close and subtracts fees once', () => {
  const optionContract = {
    contractType: 'put',
    expirationDate: '2026-12-18',
    strikePrice: 40,
    underlyingSecurityTicker: 'RBLX',
  };
  const ledger = buildStockStickiesCspLedger([
    {
      id: 'open',
      stockStickiesAccount: 'individual',
      securityId: 'rblx-put',
      date: '2026-01-10',
      name: 'sell 1.000 RBLX put with strike of $40.00 for $5.02 each to open - SOLD',
      amount: -502,
      fees: 0.04,
      type: 'sell',
      subtype: 'sell',
      optionContract,
    },
    {
      id: 'close',
      stockStickiesAccount: 'individual',
      securityId: 'rblx-put',
      date: '2026-02-10',
      name: 'buy 1.000 RBLX put with strike of $40.00 for $3.00 each to close - PURCHASED',
      amount: 300,
      fees: 0.04,
      type: 'buy',
      subtype: 'buy',
      optionContract,
    },
  ], [], 2026, '2026-07-26');

  assert.equal(ledger.accounts.individual.realizedPnl, 201.92);
  assert.equal(ledger.accounts.individual.unrealizedPnl, 0);
  assert.equal(ledger.accounts.individual.fees, 0.08);
  assert.equal(ledger.accounts.individual.openContracts, 0);
  assert.equal(ledger.accounts.individual.collateralRequired, 0);
  assert.equal(ledger.unmatchedTransactionCount, 0);
});

test('open CSP uses current option liability for unrealized P&L and collateral attribution', () => {
  const optionContract = {
    contractType: 'put',
    expirationDate: '2026-12-18',
    strikePrice: 60,
    underlyingSecurityTicker: 'RKLB',
  };
  const ledger = buildStockStickiesCspLedger([{
    id: 'open',
    stockStickiesAccount: 'individual',
    securityId: 'rklb-put',
    date: '2026-03-01',
    name: 'sell 1.000 RKLB put with strike of $60.00 for $15.00 each to open - SOLD',
    amount: -1500,
    fees: 0.04,
    type: 'sell',
    subtype: 'sell',
    optionContract,
  }], [{
    stockStickiesAccount: 'individual',
    securityId: 'rklb-put',
    quantity: -1,
    institutionValue: -1198,
    optionContract: {
      contract_type: 'put',
      expiration_date: '2026-12-18',
      strike_price: 60,
      underlying_security_ticker: 'RKLB',
    },
  }], 2026, '2026-07-26');

  assert.equal(ledger.accounts.individual.realizedPnl, 0);
  assert.equal(ledger.accounts.individual.unrealizedPnl, 301.96);
  assert.equal(ledger.accounts.individual.totalPnl, 301.96);
  assert.equal(ledger.accounts.individual.openContracts, 1);
  assert.equal(ledger.accounts.individual.collateralRequired, 6000);
  assert.equal(ledger.collateralTreatment, 'excluded-from-performance-cash-flows');
});

test('expiration and assignment realize remaining opening premium without counting collateral', () => {
  const optionContract = {
    contractType: 'put',
    expirationDate: '2026-06-19',
    strikePrice: 25,
    underlyingSecurityTicker: 'TEST',
  };
  const ledger = buildStockStickiesCspLedger([
    {
      id: 'open-expire',
      stockStickiesAccount: 'roth',
      securityId: 'expire-put',
      date: '2026-01-01',
      name: 'sell 1.000 TEST put with strike of $25.00 for $2.00 each to open - SOLD',
      amount: -200,
      fees: 0.04,
      type: 'sell',
      subtype: 'sell',
      optionContract,
    },
    {
      id: 'expire',
      stockStickiesAccount: 'roth',
      securityId: 'expire-put',
      date: '2026-06-19',
      name: 'TEST put expired',
      quantity: 1,
      amount: 0,
      fees: 0,
      type: 'cash',
      subtype: 'expire',
      optionContract,
    },
    {
      id: 'open-assign',
      stockStickiesAccount: 'roth',
      securityId: 'assign-put',
      date: '2026-02-01',
      name: 'sell 1.000 TEST put with strike of $25.00 for $1.00 each to open - SOLD',
      amount: -100,
      fees: 0.04,
      type: 'sell',
      subtype: 'sell',
      optionContract,
    },
    {
      id: 'assign',
      stockStickiesAccount: 'roth',
      securityId: 'assign-put',
      date: '2026-05-01',
      name: 'TEST put assigned',
      quantity: 1,
      amount: 2500,
      fees: 0,
      type: 'buy',
      subtype: 'assignment',
      optionContract,
    },
  ], [], 2026, '2026-07-26');

  assert.equal(ledger.accounts.roth.realizedPnl, 299.92);
  assert.equal(ledger.accounts.roth.expiredContracts, 1);
  assert.equal(ledger.accounts.roth.assignedContracts, 1);
  assert.equal(ledger.accounts.roth.collateralRequired, 0);
});

test('option trading and CSP collateral never become Modified Dietz external flows', () => {
  const result = modifiedDietzPerformance(10_000, 11_000, [
    { date: '2026-01-10', subtype: 'sell', amount: -500 },
    { date: '2026-02-10', subtype: 'buy', amount: 300 },
    { date: '2026-03-10', subtype: 'collateral', amount: 4_000 },
  ], 2026, '2026-07-26');

  assert.equal(result.netExternalFlow, 0);
  assert.equal(result.externalFlowCount, 0);
  assert.equal(result.gain, 1000);
});

test('unmatched closing puts are reported but excluded from CSP P&L', () => {
  const ledger = buildStockStickiesCspLedger([{
    id: 'missing-opening-leg',
    stockStickiesAccount: 'individual',
    securityId: 'missing-open-put',
    date: '2026-06-17',
    name: 'buy 1.000 LPTH put with strike of $12.50 for $2.30 each to close - PURCHASED',
    amount: 230,
    fees: 0.04,
    quantity: 1,
    type: 'buy',
    subtype: 'buy',
    optionContract: {
      contractType: 'put',
      expirationDate: '2026-09-18',
      strikePrice: 12.5,
      underlyingSecurityTicker: 'LPTH',
    },
  }], [], 2026, '2026-08-06');

  assert.equal(ledger.unmatchedTransactionCount, 1);
  assert.equal(ledger.accounts.individual.realizedPnl, 0);
  assert.equal(ledger.accounts.individual.closingDebits, 0);
  assert.equal(ledger.accounts.individual.fees, 0);
});

test('reviewed orphan option transactions stay excluded without recurring warnings', () => {
  const transaction = {
    id: 'reviewed-missing-opening-leg',
    stockStickiesAccount: 'individual',
    securityId: 'missing-open-put',
    date: '2026-06-17',
    name: 'buy 1.000 LPTH put with strike of $12.50 for $2.30 each to close - PURCHASED',
    amount: 230,
    fees: 0.04,
    quantity: 1,
    type: 'buy',
    subtype: 'buy',
    optionContract: {
      contractType: 'put',
      expirationDate: '2026-09-18',
      strikePrice: 12.5,
      underlyingSecurityTicker: 'LPTH',
    },
  };
  const ledger = buildStockStickiesCspLedger(
    [transaction],
    [],
    2026,
    '2026-08-06',
    { excludedTransactionIds: [transaction.id] }
  );

  assert.equal(ledger.unmatchedTransactionCount, 0);
  assert.equal(ledger.excludedTransactionCount, 1);
  assert.equal(ledger.accounts.individual.realizedPnl, 0);
  assert.equal(ledger.contracts.length, 0);
});

test('lookback transactions establish lots without counting prior-year realized P&L', () => {
  const optionContract = {
    contractType: 'put',
    expirationDate: '2026-12-18',
    strikePrice: 50,
    underlyingSecurityTicker: 'TEST',
  };
  const ledger = buildStockStickiesCspLedger([
    {
      stockStickiesAccount: 'individual',
      securityId: 'old-closed',
      date: '2025-06-01',
      name: 'sell 1.000 TEST put with strike of $50.00 for $5.00 each to open - SOLD',
      amount: -500,
      type: 'sell',
      subtype: 'sell',
      optionContract,
    },
    {
      stockStickiesAccount: 'individual',
      securityId: 'old-closed',
      date: '2025-07-01',
      name: 'buy 1.000 TEST put with strike of $50.00 for $4.00 each to close - PURCHASED',
      amount: 400,
      type: 'buy',
      subtype: 'buy',
      optionContract,
    },
    {
      stockStickiesAccount: 'individual',
      securityId: 'cross-year',
      date: '2025-12-15',
      name: 'sell 1.000 TEST put with strike of $50.00 for $6.00 each to open - SOLD',
      amount: -600,
      type: 'sell',
      subtype: 'sell',
      optionContract,
    },
    {
      stockStickiesAccount: 'individual',
      securityId: 'cross-year',
      date: '2026-01-15',
      name: 'buy 1.000 TEST put with strike of $50.00 for $2.00 each to close - PURCHASED',
      amount: 200,
      type: 'buy',
      subtype: 'buy',
      optionContract,
    },
  ], [], 2026, '2026-07-26');

  assert.equal(ledger.accounts.individual.realizedPnl, 400);
  assert.equal(ledger.accounts.individual.premiumCredits, 0);
  assert.equal(ledger.accounts.individual.closingDebits, 200);
});
