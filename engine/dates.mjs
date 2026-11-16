// Calendar dates as ISO strings (YYYY-MM-DD). All arithmetic is in UTC days,
// so a person's time zone never shifts a deadline by one.

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

export function monthNumber(word) {
  return MONTHS[String(word || '').toLowerCase().replace(/\.$/, '')] || null;
}

export function monthLong(iso) {
  return MONTH_LONG[Number(iso.slice(5, 7)) - 1];
}

export function iso(y, m, d) {
  if (!(y > 1900 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1) return null; // 31 Feb and friends
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isIso(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && iso(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)) === s;
}

function fullYear(y) {
  y = Number(y);
  return y < 100 ? 2000 + y : y;
}

// "07/18/26", "07/18/2026", "7/18/26"
export function parseMDY(s) {
  const m = String(s || '').match(/^\s*(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\s*$/);
  return m ? iso(fullYear(m[3]), +m[1], +m[2]) : null;
}

// "10/02" with a year taken from context.
export function parseMD(s, year) {
  const m = String(s || '').match(/^\s*(\d{1,2})\/(\d{1,2})\s*$/);
  return m ? iso(year, +m[1], +m[2]) : null;
}

// Loose human dates: "3 Jun 2026", "30 June 2026", "Wed, 3 Jun 2026 09:12",
// "Jun 3, 2026", "Nov 02" (needs yearHint), "2026-10-02", "10/02/26".
// yearHint: a year, or {year, notAfter} so a month later than the reference
// date rolls back into the previous year ("Dec 28" copied on 3 Jan).
export function parseLoose(s, yearHint) {
  const text = String(s || '');
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (m) return iso(fullYear(m[3]), +m[1], +m[2]);
  m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (m && monthNumber(m[2])) return iso(+m[3], monthNumber(m[2]), +m[1]);
  m = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
  if (m && monthNumber(m[1])) return iso(+m[3], monthNumber(m[1]), +m[2]);
  const hint = typeof yearHint === 'object' && yearHint ? yearHint : { year: yearHint };
  if (!hint.year) return null;
  m = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/) || null;
  let mon = null, day = null;
  if (m && monthNumber(m[1])) { mon = monthNumber(m[1]); day = +m[2]; }
  else {
    m = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\b/);
    if (m && monthNumber(m[2])) { mon = monthNumber(m[2]); day = +m[1]; }
  }
  if (!mon) return null;
  let out = iso(hint.year, mon, day);
  if (out && hint.notAfter && out > hint.notAfter) out = iso(hint.year - 1, mon, day);
  return out;
}

function toUtc(isoDate) {
  return Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10));
}

export function addDays(isoDate, n) {
  const t = new Date(toUtc(isoDate) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

// a - b, in whole days
export function diffDays(a, b) {
  return Math.round((toUtc(a) - toUtc(b)) / 86400000);
}

export function addMonths(isoDate, n) {
  let y = +isoDate.slice(0, 4), m = +isoDate.slice(5, 7) + n;
  const d = +isoDate.slice(8, 10);
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, Math.min(d, last));
}

// "18 Nov 2026": day-month-year with a month word, so nobody misreads 11/12.
export function fmt(isoDate) {
  if (!isIso(isoDate)) return 'unknown date';
  return `${Number(isoDate.slice(8, 10))} ${MONTH_NAMES[+isoDate.slice(5, 7) - 1]} ${isoDate.slice(0, 4)}`;
}

export function fmtWeekday(isoDate) {
  if (!isIso(isoDate)) return 'unknown date';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(toUtc(isoDate)).getUTCDay()];
  return `${wd} ${fmt(isoDate)}`;
}

export function todayLocal(now = new Date()) {
  return iso(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
