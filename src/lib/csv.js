// UTF-8 CSV with BOM (so Excel shows Arabic correctly) and spreadsheet
// formula-injection protection on export.
export function safeCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export function toCsv(cols, rows) {
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => safeCell(r[c])).join(','))].join('\r\n') + '\r\n';
}
