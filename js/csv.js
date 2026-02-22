import { uid } from './utils.js';

export function parseCsv(text) {
  const rows = [];
  let current = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (c === ',' && !inQuotes) {
      row.push(current);
      current = '';
      continue;
    }
    if ((c === '\n' || c === '\r') && !inQuotes) {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      if (current.length || row.length) {
        row.push(current);
        rows.push(row);
      }
      current = '';
      row = [];
      continue;
    }
    current += c;
  }
  if (current.length || row.length) {
    row.push(current);
    rows.push(row);
  }
  return rows;
}

function parseDate(input) {
  if (!input) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  const mdy = input.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function hashTx(tx) {
  return `${tx.date}|${tx.amount.toFixed(2)}|${tx.description.trim().toLowerCase()}|${tx.accountId}`;
}

export function mapCsvToTransactions(rows, mapper, accountId, existingTransactions = []) {
  const [header, ...data] = rows;
  if (!header || !data.length) return [];

  const seen = new Set(existingTransactions.map(hashTx));
  const created = [];

  for (const r of data) {
    const date = parseDate(r[mapper.date]);
    if (!date) continue;
    const description = r[mapper.description] || 'Imported Transaction';

    let amount = 0;
    if (mapper.amount != null) {
      amount = Number((r[mapper.amount] || '0').replace(/[$,]/g, ''));
    } else {
      const debit = Number((r[mapper.debit] || '0').replace(/[$,]/g, ''));
      const credit = Number((r[mapper.credit] || '0').replace(/[$,]/g, ''));
      amount = credit - debit;
    }

    const tx = {
      id: uid('tx'),
      date,
      description,
      amount,
      accountId,
      categoryId: null,
      status: 'Unmatched',
      notes: '',
    };

    const key = hashTx(tx);
    if (mapper.idempotent && seen.has(key)) continue;
    seen.add(key);
    created.push(tx);
  }

  return created;
}
