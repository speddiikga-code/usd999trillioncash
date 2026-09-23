/**
 * RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, embedded newlines).
 * Returns rows as objects keyed by lower-cased, trimmed header names.
 */
export function parseCsv(text: string, opts: { maxRows?: number } = {}): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      if (opts.maxRows && rows.length > opts.maxRows) break;
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== '')) rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  return rows.slice(1, opts.maxRows ? opts.maxRows + 1 : undefined).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}
