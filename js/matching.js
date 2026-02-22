import { normalizeDescription } from './utils.js';

export function findMatchSuggestions(transactions, occurrences, rules = []) {
  const suggestions = [];

  for (const tx of transactions) {
    const desc = normalizeDescription(tx.description);
    const candidateRules = rules.filter((r) => {
      if (r.accountId && r.accountId !== tx.accountId) return false;
      if (!r.pattern) return true;
      const pattern = r.isRegex ? new RegExp(r.pattern, 'i') : null;
      return pattern ? pattern.test(desc) : desc.includes(normalizeDescription(r.pattern));
    });

    const candidates = occurrences.filter((occ) => {
      const tolerance = Number(candidateRules[0]?.amountTolerance ?? 2);
      const dateWindow = Number(candidateRules[0]?.dateWindowDays ?? 5);
      const diff = Math.abs(Math.abs(occ.amount) - Math.abs(tx.amount));
      const dayDiff = Math.abs((new Date(occ.date) - new Date(tx.date)) / (1000 * 60 * 60 * 24));
      return occ.accountId === tx.accountId && diff <= tolerance && dayDiff <= dateWindow;
    });

    if (candidates.length) {
      suggestions.push({ txId: tx.id, occurrenceId: candidates[0].id, confidence: 0.9, status: 'Matched' });
    } else {
      suggestions.push({ txId: tx.id, occurrenceId: null, confidence: 0, status: 'Needs Review' });
    }
  }

  return suggestions;
}

export function applyMatchSuggestions(transactions, suggestions) {
  const map = new Map(suggestions.map((s) => [s.txId, s]));
  return transactions.map((tx) => {
    const s = map.get(tx.id);
    if (!s || !s.occurrenceId) return { ...tx, status: tx.status || 'Unmatched' };
    return { ...tx, status: 'Matched', matchedScheduledOccurrenceId: s.occurrenceId };
  });
}
