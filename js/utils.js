export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function toYearMonth(dateInput) {
  const d = new Date(dateInput);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  return `${y}-${m}`;
}

export function parseYearMonth(yearMonth) {
  const [year, month] = yearMonth.split('-').map(Number);
  return { year, month };
}

export function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount || 0);
}

export function normalizeDescription(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function monthRange(startYm, endYm) {
  const out = [];
  let { year, month } = parseYearMonth(startYm);
  const end = parseYearMonth(endYm);
  while (year < end.year || (year === end.year && month <= end.month)) {
    out.push(`${year}-${`${month}`.padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

export function sortByDate(items, key = 'date') {
  return [...items].sort((a, b) => new Date(a[key]) - new Date(b[key]));
}
