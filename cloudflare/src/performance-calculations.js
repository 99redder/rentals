export const STOCK_STICKIES_ACCOUNT_IDS = ['individual', 'traditional', 'roth'];

const EXTERNAL_FLOW_SUBTYPES = new Set([
  'contribution',
  'deposit',
  'distribution',
  'withdrawal',
]);
const MANUAL_FLOW_MATCH_WINDOW_MS = 10 * 86_400_000;

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
  return externalFlowSubtype(transaction) !== '';
}

export function stockStickiesExternalFlow(transaction) {
  if (!isRecognizedExternalFlow(transaction)) return null;
  const amount = Number(transaction?.amount);
  return Number.isFinite(amount) ? -amount : null;
}

export function stockStickiesExternalFlowDate(transaction) {
  const transactionDate = String(transaction?.transactionDatetime || '').slice(0, 10);
  if (Number.isFinite(Date.parse(`${transactionDate}T12:00:00Z`))) return transactionDate;
  return String(transaction?.date || '').slice(0, 10);
}

function externalFlowSubtype(transaction) {
  const subtype = String(transaction?.subtype || '').toLowerCase();
  if (EXTERNAL_FLOW_SUBTYPES.has(subtype)) return subtype;

  // Robinhood currently sends ACH activity through Plaid as the generic
  // transfer/transfer pair. Only promote descriptions that explicitly name an
  // ACH deposit or withdrawal; generic/internal transfers must remain ignored.
  if (String(transaction?.type || '').toLowerCase() !== 'transfer') return '';
  const description = String(transaction?.name || '').toLowerCase();
  if (/\bach\s+deposit\b/.test(description)) return 'deposit';
  if (/\bach\s+withdrawal\b/.test(description)) return 'withdrawal';
  return '';
}

export function mergeStockStickiesTransactions(
  plaidTransactions,
  manualTransactions,
  manualCoverageThrough = null
) {
  const plaid = Array.isArray(plaidTransactions) ? plaidTransactions : [];
  const manual = Array.isArray(manualTransactions) ? manualTransactions : [];
  const manuallyReconciledAccounts = new Set(
    manual
      .map(transaction => transaction?.stockStickiesAccount)
      .filter(account => STOCK_STICKIES_ACCOUNT_IDS.includes(account))
  );
  // A user-confirmed/manual flow may bridge the delay between a live holdings
  // refresh and Plaid's investment-transaction export. Once Plaid later emits
  // the same flow (Robinhood settlement dates can lag several days), remove
  // the Plaid copy by account, direction, amount, and a bounded date window.
  const matchedPlaidTransactions = new Set();
  const availablePlaidFlows = plaid
    .map((transaction, index) => ({
      transaction,
      index,
      flow: stockStickiesExternalFlow(transaction),
      dateMs: Date.parse(`${stockStickiesExternalFlowDate(transaction)}T12:00:00Z`),
    }))
    .filter(candidate =>
      candidate.flow !== null && Number.isFinite(candidate.dateMs)
    );
  for (const manualTransaction of manual) {
    const manualFlow = stockStickiesExternalFlow(manualTransaction);
    const manualDateMs = Date.parse(`${stockStickiesExternalFlowDate(manualTransaction)}T12:00:00Z`);
    if (manualFlow === null || !Number.isFinite(manualDateMs)) continue;
    const match = availablePlaidFlows
      .filter(candidate =>
        !matchedPlaidTransactions.has(candidate.index) &&
        candidate.transaction?.stockStickiesAccount ===
          manualTransaction?.stockStickiesAccount &&
        Math.abs(candidate.flow - manualFlow) < 0.005 &&
        Math.abs(candidate.dateMs - manualDateMs) <= MANUAL_FLOW_MATCH_WINDOW_MS
      )
      .sort((left, right) =>
        Math.abs(left.dateMs - manualDateMs) - Math.abs(right.dateMs - manualDateMs)
      )[0];
    if (match) matchedPlaidTransactions.add(match.index);
  }
  const merged = plaid.filter((transaction, index) =>
    {
      return !matchedPlaidTransactions.has(index) && !(
      manuallyReconciledAccounts.has(transaction?.stockStickiesAccount) &&
      isRecognizedExternalFlow(transaction) &&
      (
        !manualCoverageThrough ||
        !manualCoverageThrough[transaction.stockStickiesAccount] ||
        String(transaction?.date || '') <=
          String(manualCoverageThrough[transaction.stockStickiesAccount])
      )
      );
    }
  );
  const seen = new Set(merged.map(transaction => String(transaction?.id || '')).filter(Boolean));
  for (const transaction of manual) {
    const id = String(transaction?.id || '');
    if (id && seen.has(id)) continue;
    merged.push(transaction);
    if (id) seen.add(id);
  }
  return merged;
}

export function anchoredInstitutionPerformance(
  reportedGain,
  anchorValue,
  currentValue,
  transactions,
  anchorDate,
  endDate
) {
  if (
    !Number.isFinite(reportedGain) ||
    !Number.isFinite(anchorValue) ||
    !Number.isFinite(currentValue)
  ) return null;
  const anchorMs = Date.parse(`${anchorDate}T12:00:00Z`);
  const endMs = Date.parse(`${endDate}T12:00:00Z`);
  if (!Number.isFinite(anchorMs) || !Number.isFinite(endMs) || endMs < anchorMs) return null;
  let netExternalFlowAfterAnchor = 0;
  let externalFlowCountAfterAnchor = 0;
  for (const transaction of Array.isArray(transactions) ? transactions : []) {
    const flow = stockStickiesExternalFlow(transaction);
    const flowMs = Date.parse(`${stockStickiesExternalFlowDate(transaction)}T12:00:00Z`);
    if (flow === null || !Number.isFinite(flowMs) || flowMs <= anchorMs || flowMs > endMs) continue;
    netExternalFlowAfterAnchor += flow;
    externalFlowCountAfterAnchor += 1;
  }
  const valueChangeAfterAnchor = currentValue - anchorValue;
  return {
    gain: reportedGain + valueChangeAfterAnchor - netExternalFlowAfterAnchor,
    valueChangeAfterAnchor,
    netExternalFlowAfterAnchor,
    externalFlowCountAfterAnchor,
  };
}

export function aggregateModifiedDietzReturn(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return null;
  if (!accounts.every(account =>
    Number.isFinite(account?.gain) &&
    Number.isFinite(account?.weightedCapital) &&
    account.weightedCapital > 0
  )) return null;
  const gain = accounts.reduce((sum, account) => sum + account.gain, 0);
  const weightedCapital = accounts.reduce((sum, account) => sum + account.weightedCapital, 0);
  return weightedCapital > 0 ? (gain / weightedCapital) * 100 : null;
}

// Backward-compatible export for callers that have not migrated to the more
// accurate methodology name yet.
export const aggregateTimeWeightedReturn = aggregateModifiedDietzReturn;

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
    const flowMs = Date.parse(`${stockStickiesExternalFlowDate(transaction)}T12:00:00Z`);
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
    weightedCapital: denominator > 0 ? denominator : null,
    netExternalFlow,
    externalFlowCount,
  };
}

function brokerageCashValues(snapshot) {
  const values = Object.fromEntries(STOCK_STICKIES_ACCOUNT_IDS.map(id => [id, 0]));
  for (const position of Array.isArray(snapshot?.positions) ? snapshot.positions : []) {
    const account = String(position?.stockStickiesAccount || '');
    const ticker = String(position?.ticker || '').trim().toUpperCase();
    const unofficialCurrency = String(position?.unofficialCurrencyCode || '').trim().toUpperCase();
    const isBrokerageCash = ticker === 'USD' || ticker === 'CUR:USD' ||
      (!ticker && unofficialCurrency === 'USD');
    const value = Number(position?.institutionValue);
    if (!STOCK_STICKIES_ACCOUNT_IDS.includes(account) || !isBrokerageCash || !Number.isFinite(value)) {
      continue;
    }
    values[account] += value;
  }
  return values;
}

/**
 * Detects the Plaid race where cash/NAV moves before the matching investment
 * transaction is published. It deliberately requires cash and NAV to move by
 * nearly the same material amount so ordinary market movement and trades do
 * not make performance provisional.
 */
export function assessStockStickiesRefreshConsistency(
  previousSnapshot,
  currentSnapshot,
  transactions
) {
  const previousFetchedMs = Date.parse(String(previousSnapshot?.fetchedAt || ''));
  const currentFetchedMs = Date.parse(String(currentSnapshot?.fetchedAt || ''));
  if (!Number.isFinite(previousFetchedMs) || !Number.isFinite(currentFetchedMs) ||
      currentFetchedMs <= previousFetchedMs) {
    return { status: 'not-comparable', provisionalAccounts: [], discrepancies: [] };
  }

  const previousAccounts = stockStickiesAccountValues(previousSnapshot);
  const currentAccounts = stockStickiesAccountValues(currentSnapshot);
  const previousCash = brokerageCashValues(previousSnapshot);
  const currentCash = brokerageCashValues(currentSnapshot);
  const previousDate = new Date(previousFetchedMs).toISOString().slice(0, 10);
  const currentDate = new Date(currentFetchedMs).toISOString().slice(0, 10);
  const discrepancies = [];

  for (const account of STOCK_STICKIES_ACCOUNT_IDS) {
    const navChange = currentAccounts[account] - previousAccounts[account];
    const cashChange = currentCash[account] - previousCash[account];
    const materialThreshold = Math.max(250, Math.abs(previousAccounts[account]) * 0.005);
    const alignmentTolerance = Math.max(250, Math.abs(cashChange) * 0.2);
    if (Math.abs(navChange) < materialThreshold || Math.abs(cashChange) < materialThreshold ||
        Math.sign(navChange) !== Math.sign(cashChange) ||
        Math.abs(navChange - cashChange) > alignmentTolerance) continue;

    const matchingFlows = (Array.isArray(transactions) ? transactions : [])
      .filter(transaction => {
        const flowDate = stockStickiesExternalFlowDate(transaction);
        return transaction?.stockStickiesAccount === account &&
          flowDate >= previousDate && flowDate <= currentDate;
      })
      .map(stockStickiesExternalFlow)
      .filter(flow => flow !== null && Math.sign(flow) === Math.sign(navChange));
    const matchingFlowTotal = matchingFlows.reduce((sum, flow) => sum + flow, 0);
    if (Math.abs(navChange - matchingFlowTotal) <= alignmentTolerance) continue;

    discrepancies.push({
      account,
      navChange: roundMoney(navChange),
      brokerageCashChange: roundMoney(cashChange),
      recognizedExternalFlow: roundMoney(matchingFlowTotal),
    });
  }

  return {
    status: discrepancies.length ? 'provisional' : 'coherent',
    provisionalAccounts: discrepancies.map(discrepancy => discrepancy.account),
    discrepancies,
  };
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionDescription(transaction) {
  return String(transaction?.name || '').toLowerCase();
}

function optionContracts(transaction) {
  const descriptionMatch = String(transaction?.name || '').match(/\b(?:buy|sell)\s+([\d.]+)\s+/i);
  if (descriptionMatch) return Math.abs(finiteNumber(descriptionMatch[1]));
  const quantity = Math.abs(finiteNumber(transaction?.quantity));
  // Plaid sometimes reports option quantity as contracts and sometimes as the
  // deliverable quantity (contracts × 100). The Robinhood description is the
  // preferred source, but normalize the latter shape when it is all we have.
  return quantity >= 100 && Number.isInteger(quantity / 100) ? quantity / 100 : quantity;
}

function optionLifecycleAction(transaction) {
  const description = optionDescription(transaction);
  const type = String(transaction?.type || '').toLowerCase();
  const subtype = String(transaction?.subtype || '').toLowerCase();
  if (subtype === 'assignment' || /\bassign(?:ed|ment)?\b/.test(description)) return 'assigned';
  if (subtype === 'expire' || /\bexpir(?:e|ed|ation)\b/.test(description)) return 'expired';
  if (/\bto open\b/.test(description)) return type === 'sell' ? 'open-short' : 'open-long';
  if (/\bto close\b/.test(description)) return type === 'buy' ? 'close-short' : 'close-long';
  if (subtype === 'sell short') return 'open-short';
  if (subtype === 'buy to cover') return 'close-short';
  return 'unknown';
}

function optionContractKey(record) {
  const account = String(record?.stockStickiesAccount || '');
  const securityId = String(record?.securityId || '');
  if (securityId) return `${account}|${securityId}`;
  const contract = record?.optionContract || {};
  return [
    account,
    String(record?.ticker || ''),
    String(contract?.underlyingSecurityTicker || contract?.underlying_security_ticker || ''),
    String(contract?.expirationDate || contract?.expiration_date || ''),
    finiteNumber(contract?.strikePrice ?? contract?.strike_price, ''),
    String(contract?.contractType || contract?.contract_type || ''),
  ].join('|');
}

function isPutOption(record) {
  const contract = record?.optionContract || {};
  const contractType = String(
    contract.contractType || contract.contract_type || record?.optionType || ''
  ).toLowerCase();
  return contractType === 'put' || /\bput\b/i.test(String(record?.name || ''));
}

function roundMoney(value) {
  return Math.round((finiteNumber(value) + Number.EPSILON) * 100) / 100;
}

/**
 * Builds an attribution ledger for short puts. It intentionally never treats
 * collateral reservations/releases as cash flows: only option fills, fees,
 * expiration/assignment, and the current option liability affect CSP P&L.
 * Total account performance remains NAV minus true external cash flows.
 */
export function buildStockStickiesCspLedger(
  transactions,
  positions,
  year,
  endDate,
  options = {}
) {
  const yearStart = `${year}-01-01`;
  const excludedTransactionIds = new Set(
    Array.isArray(options?.excludedTransactionIds)
      ? options.excludedTransactionIds.map(String)
      : []
  );
  let excludedTransactionCount = 0;
  const inputTransactions = (Array.isArray(transactions) ? transactions : [])
    .filter(transaction =>
      isPutOption(transaction) &&
      String(transaction?.date || '') <= endDate
    )
    .sort((left, right) => {
      const dateOrder = String(left?.date || '').localeCompare(String(right?.date || ''));
      if (dateOrder) return dateOrder;
      return String(left?.transactionDatetime || left?.id || '')
        .localeCompare(String(right?.transactionDatetime || right?.id || ''));
    });
  const currentPositions = new Map(
    (Array.isArray(positions) ? positions : [])
      .filter(position => isPutOption(position) && finiteNumber(position?.quantity) < 0)
      .map(position => [optionContractKey(position), position])
  );
  const contracts = new Map();
  let unmatchedTransactionCount = 0;
  let ledgerTransactionCount = 0;

  for (const transaction of inputTransactions) {
    if (excludedTransactionIds.has(String(transaction?.id || ''))) {
      excludedTransactionCount += 1;
      continue;
    }
    const action = optionLifecycleAction(transaction);
    // Long puts are directional trades, not cash-secured puts.
    if (action === 'open-long' || action === 'close-long') continue;
    ledgerTransactionCount += 1;
    const key = optionContractKey(transaction);
    if (!contracts.has(key)) {
      const contract = transaction.optionContract || {};
      contracts.set(key, {
        key,
        account: transaction.stockStickiesAccount,
        securityId: transaction.securityId || null,
        ticker: transaction.ticker || '',
        underlyingTicker:
          contract.underlyingSecurityTicker || contract.underlying_security_ticker || '',
        expirationDate: contract.expirationDate || contract.expiration_date || null,
        strikePrice: finiteNumber(contract.strikePrice ?? contract.strike_price, null),
        openLots: [],
        realizedPnl: 0,
        premiumCredits: 0,
        closingDebits: 0,
        fees: 0,
        expiredContracts: 0,
        assignedContracts: 0,
        unmatchedTransactions: 0,
        lastActivityDate: transaction.date,
      });
    }
    const ledger = contracts.get(key);
    const contractsCount = optionContracts(transaction);
    const fees = Math.max(0, finiteNumber(transaction.fees));
    const grossCash = -finiteNumber(transaction.amount);
    const netCash = grossCash - fees;
    const isYtdEvent = String(transaction?.date || '') >= yearStart;
    ledger.lastActivityDate = transaction.date;

    if (action === 'open-short' && contractsCount > 0) {
      if (isYtdEvent) {
        ledger.premiumCredits += Math.max(0, grossCash);
        ledger.fees += fees;
      }
      ledger.openLots.push({
        openedAt: transaction.date,
        contracts: contractsCount,
        remainingContracts: contractsCount,
        netCredit: netCash,
        remainingNetCredit: netCash,
      });
      continue;
    }

    if (action === 'close-short' && contractsCount > 0) {
      let remainingToClose = contractsCount;
      let matchedOpeningCredit = 0;
      for (const lot of ledger.openLots) {
        if (remainingToClose <= 0 || lot.remainingContracts <= 0) continue;
        const matched = Math.min(remainingToClose, lot.remainingContracts);
        const allocatedCredit = lot.remainingNetCredit * (matched / lot.remainingContracts);
        lot.remainingContracts -= matched;
        lot.remainingNetCredit -= allocatedCredit;
        matchedOpeningCredit += allocatedCredit;
        remainingToClose -= matched;
      }
      const matchedRatio = (contractsCount - remainingToClose) / contractsCount;
      if (isYtdEvent) {
        ledger.realizedPnl += matchedOpeningCredit + (netCash * matchedRatio);
        ledger.closingDebits += Math.max(0, -grossCash) * matchedRatio;
        ledger.fees += fees * matchedRatio;
      }
      if (remainingToClose > 0) {
        ledger.unmatchedTransactions += 1;
        unmatchedTransactionCount += 1;
      }
      continue;
    }

    if ((action === 'expired' || action === 'assigned') && contractsCount > 0) {
      let remainingToResolve = contractsCount;
      let releasedOpeningCredit = 0;
      for (const lot of ledger.openLots) {
        if (remainingToResolve <= 0 || lot.remainingContracts <= 0) continue;
        const matched = Math.min(remainingToResolve, lot.remainingContracts);
        const allocatedCredit = lot.remainingNetCredit * (matched / lot.remainingContracts);
        lot.remainingContracts -= matched;
        lot.remainingNetCredit -= allocatedCredit;
        releasedOpeningCredit += allocatedCredit;
        remainingToResolve -= matched;
      }
      const matchedRatio = (contractsCount - remainingToResolve) / contractsCount;
      if (isYtdEvent) {
        ledger.realizedPnl += releasedOpeningCredit - (fees * matchedRatio);
        ledger.fees += fees * matchedRatio;
        if (action === 'expired') ledger.expiredContracts += contractsCount - remainingToResolve;
        if (action === 'assigned') ledger.assignedContracts += contractsCount - remainingToResolve;
      }
      if (remainingToResolve > 0) {
        ledger.unmatchedTransactions += 1;
        unmatchedTransactionCount += 1;
      }
      continue;
    }

    // A generic buy/sell without lifecycle wording cannot be safely assigned
    // to an opening or closing lot. Preserve the count for reconciliation.
    ledger.unmatchedTransactions += 1;
    unmatchedTransactionCount += 1;
  }

  const accountSummaries = Object.fromEntries(
    STOCK_STICKIES_ACCOUNT_IDS.map(account => [account, {
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalPnl: 0,
      premiumCredits: 0,
      closingDebits: 0,
      fees: 0,
      collateralRequired: 0,
      openContracts: 0,
      expiredContracts: 0,
      assignedContracts: 0,
      unmatchedTransactionCount: 0,
      pendingResolutionContracts: 0,
    }])
  );
  const contractRows = [];
  for (const ledger of contracts.values()) {
    const remainingContracts = ledger.openLots.reduce(
      (sum, lot) => sum + lot.remainingContracts,
      0
    );
    const remainingNetCredit = ledger.openLots.reduce(
      (sum, lot) => sum + lot.remainingNetCredit,
      0
    );
    const position = currentPositions.get(ledger.key);
    const pendingResolutionContracts = remainingContracts > 0 && !position
      ? remainingContracts
      : 0;
    const openContracts = position ? remainingContracts : 0;
    const currentLiability = position
      ? Math.min(0, finiteNumber(position.institutionValue))
      : 0;
    const unrealizedPnl = openContracts > 0
      ? remainingNetCredit + currentLiability
      : 0;
    const collateralRequired = openContracts > 0 && Number.isFinite(ledger.strikePrice)
      ? openContracts * ledger.strikePrice * 100
      : 0;
    const row = {
      account: ledger.account,
      securityId: ledger.securityId,
      ticker: ledger.ticker,
      underlyingTicker: ledger.underlyingTicker,
      expirationDate: ledger.expirationDate,
      strikePrice: ledger.strikePrice,
      status: pendingResolutionContracts > 0 ? 'pending-resolution' :
        (openContracts > 0 ? 'open' : 'resolved'),
      openContracts: roundMoney(openContracts),
      pendingResolutionContracts: roundMoney(pendingResolutionContracts),
      collateralRequired: roundMoney(collateralRequired),
      premiumCredits: roundMoney(ledger.premiumCredits),
      closingDebits: roundMoney(ledger.closingDebits),
      fees: roundMoney(ledger.fees),
      realizedPnl: roundMoney(ledger.realizedPnl),
      unrealizedPnl: roundMoney(unrealizedPnl),
      totalPnl: roundMoney(ledger.realizedPnl + unrealizedPnl),
      expiredContracts: roundMoney(ledger.expiredContracts),
      assignedContracts: roundMoney(ledger.assignedContracts),
      unmatchedTransactionCount: ledger.unmatchedTransactions,
      lastActivityDate: ledger.lastActivityDate,
    };
    contractRows.push(row);
    const summary = accountSummaries[ledger.account];
    if (!summary) continue;
    for (const field of [
      'realizedPnl', 'unrealizedPnl', 'totalPnl', 'premiumCredits', 'closingDebits',
      'fees', 'collateralRequired', 'openContracts', 'expiredContracts', 'assignedContracts',
      'unmatchedTransactionCount', 'pendingResolutionContracts',
    ]) summary[field] += finiteNumber(row[field]);
  }
  for (const summary of Object.values(accountSummaries)) {
    for (const field of Object.keys(summary)) summary[field] = roundMoney(summary[field]);
  }

  return {
    year,
    asOf: endDate,
    methodology: 'short-put-lifecycle-ledger',
    pnlPeriod: 'ytd-realized-plus-current-open-trade-unrealized',
    collateralTreatment: 'excluded-from-performance-cash-flows',
    transactionCount: ledgerTransactionCount,
    unmatchedTransactionCount,
    excludedTransactionCount,
    pendingResolutionCount: contractRows.filter(row => row.status === 'pending-resolution').length,
    pendingResolutionContracts: roundMoney(contractRows.reduce(
      (sum, row) => sum + row.pendingResolutionContracts,
      0
    )),
    accounts: accountSummaries,
    contracts: contractRows
      .filter(row =>
        row.lastActivityDate >= yearStart ||
        row.openContracts > 0 ||
        row.pendingResolutionContracts > 0 ||
        row.realizedPnl !== 0
      )
      .sort((left, right) =>
        String(right.lastActivityDate).localeCompare(String(left.lastActivityDate))
      ),
  };
}
