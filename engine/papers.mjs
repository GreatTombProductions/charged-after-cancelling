// Reading a person's papers. Each paper is plain text (pasted, a .txt/.eml
// file, or text read from a PDF). Every fact keeps a pointer to the line it
// came from, so the page can show where each date and amount was read.

import { parseMDY, parseMD, parseLoose, isIso } from './dates.mjs';

const MONEY = /-?\$?-?[\d,]+\.\d{2}/;

export function money(s) {
  const m = String(s || '').replace(/[\s$,]/g, '').match(/^(-?)-?(\d+(?:\.\d{1,2})?)$/);
  if (!m) return null;
  const v = Math.round(parseFloat(m[2]) * 100) / 100;
  return String(s).includes('-') ? -v : v;
}

export function compact(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function src(paper, lineIndex, lines) {
  return { paper: paper.id, line: lineIndex + 1, text: (lines[lineIndex] || '').trim() };
}

function findLine(lines, re, from = 0) {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

// ---------------------------------------------------------------- classify

export function classify(text) {
  const t = String(text || '');
  if (/^\s*From:/mi.test(t) && /^\s*(Date|Sent):/mi.test(t)) return 'email';
  if (/minimum payment (due)?/i.test(t) && /(closing date|statement closing|billing cycle|payment due date)/i.test(t)) return 'card-statement';
  if (/(checking|savings)/i.test(t) && /(statement period|beginning balance|ending balance)/i.test(t)) return 'bank-statement';
  if (/DEBIT CARD PURCHASE/i.test(t) && !/minimum payment/i.test(t)) return 'bank-statement';
  if (/(closing date|opening\/closing)/i.test(t) && /new balance/i.test(t)) return 'card-statement';
  const appLines = t.split(/\r?\n/).filter(l => /^\s*[A-Z][a-z]{2}\s+\d{1,2}\s+\S.*\s-?\$-?[\d,]+\.\d{2}/.test(l)).length;
  if (appLines >= 1) return 'app-list';
  if (/^\s*\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s*$/m.test(t.split(/\r?\n/)[0] || '') && /\bI\b/.test(t)) return 'own-note';
  return 'other';
}

// ---------------------------------------------------------- card statement

// Address blocks. Handles "Label: one line, with, commas" and labels that sit
// side by side in columns, each followed by its own lines.
function labelledBlocks(lines) {
  const labels = [
    { key: 'payment', re: /send payments? to:?/i },
    { key: 'payment', re: /payment address:?/i },
    { key: 'billing', re: /billing (inquiries|errors?)(\s*\([^)]*\))?\s*:/i },
    { key: 'billing', re: /write to us at:?/i },
  ];
  const out = [];
  lines.forEach((line, i) => {
    const hits = [];
    for (const l of labels) {
      const m = line.match(l.re);
      if (m) hits.push({ key: l.key, col: m.index, end: m.index + m[0].length });
    }
    if (!hits.length) return;
    hits.sort((a, b) => a.col - b.col);
    hits.forEach((h, k) => {
      const nextCol = k + 1 < hits.length ? hits[k + 1].col : Infinity;
      const sameLine = line.slice(h.end, nextCol === Infinity ? undefined : nextCol).trim();
      let value = [], first = i;
      if (sameLine) {
        value = sameLine.split(/\s*,\s*/).reduce((acc, piece) => {
          // "Larkspur Falls, ZZ 00099" stays one postal line
          if (acc.length && /^[A-Z]{2}\s+\d{5}/.test(piece)) acc[acc.length - 1] += `, ${piece}`;
          else acc.push(piece);
          return acc;
        }, []);
      } else {
        const indentMode = /write to us at/i.test(line) && hits.length === 1;
        for (let j = i + 1; j < lines.length; j++) {
          const raw = lines[j];
          if (!raw.trim()) break;
          let piece;
          if (indentMode) {
            if (!/^\s+\S/.test(raw)) break;
            piece = raw.trim();
          } else {
            piece = raw.slice(h.col, nextCol === Infinity ? undefined : nextCol).trim();
            if (!piece) break;
          }
          value.push(piece);
          if (first === i) first = j;
        }
      }
      out.push({ key: h.key, lines: value, labelLine: i, firstLine: first, sameLine: !!sameLine });
    });
  });
  // An address names a box or street and a postal line; "see Your Billing
  // Rights on the back" is a pointer, not an address.
  return out.filter(b => b.lines.length && /\d/.test(b.lines.join(' ')) && /(p\.?\s*o\.?\s*box|\d+\s+\w+\s+(road|rd|street|st|ave|avenue|way|drive|dr|lane|ln|blvd)|\b[A-Z]{2}\s+\d{5})/i.test(b.lines.join(' ')));
}

function billingRights(text, lines, paper) {
  const has = /(if you think there is an error|write to us at|notify us of any potential errors|billing rights summary|your billing rights:)/i.test(text);
  if (!has) return { present: false };
  const r = { present: true, electronic: null, electronicMeans: null, disclaimsElectronic: false, disclaimsPhone: false, src: [] };
  const sentences = text.replace(/\s*\r?\n\s*/g, ' ').split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const writingOrElectronic = s.match(/in writing or electronically\s*(?:(?:using|through|via|by)\s+(?:the\s+)?)?([^.]*)/i);
    if (writingOrElectronic && !/not required to investigate/i.test(s)) {
      r.electronic = true;
      r.electronicMeans = writingOrElectronic[1].trim() || null;
      r.src.push(s.trim());
    }
    if (/electronically,? but if you do,? we are not required to investigate/i.test(s)) {
      r.disclaimsElectronic = true; r.src.push(s.trim());
    }
    if (/(call|telephone) us,?(?: or notify us electronically)?,? but (if you do,? )?(we are not required to investigate|doing so will not preserve)/i.test(s)) {
      r.disclaimsPhone = true;
    }
  }
  const means = text.match(/(?:you may also contact us electronically|electronic notices?)\s*:\s*([^\n]+)/i);
  if (r.electronic && means) r.electronicDetail = means[1].replace(/\s+/g, ' ').trim();
  if (r.electronic === null) r.electronic = false;
  const i = findLine(lines, /notify us of any potential errors/i);
  if (i >= 0) r.line = src(paper, i, lines);
  return r;
}

function parseCardStatement(paper) {
  const text = paper.text, lines = text.split(/\r?\n/);
  const out = { kind: 'card-statement', paperId: paper.id, transactions: [], facts: {} };
  const firstLine = lines.findIndex(l => l.trim());
  if (firstLine >= 0) {
    const parts = lines[firstLine].trim().split(/\s+[-–—]\s+/);
    out.issuer = { value: titleCase(parts[0]), src: src(paper, firstLine, lines) };
    if (parts[1]) out.product = parts[1].trim();
  }
  let i = findLine(lines, /account (number )?ending( in)?\s*:?\s*\d{3,4}/i);
  if (i >= 0) out.ending = { value: lines[i].match(/ending(?: in)?\s*:?\s*(\d{3,4})/i)[1], src: src(paper, i, lines) };
  i = findLine(lines, /cardholder\s*:/i);
  if (i >= 0) out.cardholder = { value: titleCase(lines[i].match(/cardholder\s*:\s*(.+?)\s*$/i)[1]), src: src(paper, i, lines) };
  i = findLine(lines, /(opening\/closing date|statement period|billing cycle)/i);
  if (i >= 0) {
    const ds = [...lines[i].matchAll(/\d{1,2}\/\d{1,2}\/\d{2,4}/g)].map(m => parseMDY(m[0]));
    if (ds.length >= 2) { out.opening = { value: ds[0], src: src(paper, i, lines) }; out.closing = { value: ds[1], src: src(paper, i, lines) }; }
    else if (ds.length === 1) out.closing = { value: ds[0], src: src(paper, i, lines) };
  }
  if (!out.closing) {
    i = findLine(lines, /closing date\s*:?\s*\d/i);
    if (i >= 0) out.closing = { value: parseMDY(lines[i].match(/closing date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)[1]), src: src(paper, i, lines) };
  }
  i = findLine(lines, /payment due date/i);
  if (i >= 0) {
    const m = lines[i].match(/payment due date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (m) out.due = { value: parseMDY(m[1]), src: src(paper, i, lines) };
  }
  i = findLine(lines, /minimum payment/i);
  if (i >= 0) {
    const m = lines[i].match(/minimum payment(?: due)?\s*:?\s*(\$?[\d,]+\.\d{2})/i);
    out.minimum = { value: m ? money(m[1]) : true, src: src(paper, i, lines) };
  }
  if (/\b(business|corporate|commercial)\b/i.test(lines.slice(0, 6).join(' '))) out.businessHint = true;
  if (/\b(prepaid)\b/i.test(lines.slice(0, 6).join(' '))) out.prepaidHint = true;

  for (const b of labelledBlocks(lines)) {
    const value = { value: b.lines.join('\n'), src: src(paper, b.firstLine, lines) };
    if (b.key === 'billing' && !out.billingAddress) out.billingAddress = value;
    if (b.key === 'payment' && !out.paymentAddress) out.paymentAddress = value;
  }
  out.rights = billingRights(text, lines, paper);
  if (/page\s+\d+\s+of\s+\d+/i.test(text) && /(not kept|missing|remaining pages)/i.test(text)) out.pagesMissing = true;

  // Transactions: "07/01/26  07/02/26  2469...  IRONLEAF FITNESS ...  49.00"
  const start = findLine(lines, /^\s*TRANSACTIONS\b/i);
  const header = start >= 0 ? findLine(lines, /trans(action)?\.?\s*date/i, start) : -1;
  const from = header >= 0 ? header + 1 : (start >= 0 ? start + 1 : 0);
  for (let j = from; j < lines.length; j++) {
    const line = lines[j];
    if (/^\s*---/.test(line) || /billing rights/i.test(line)) break;
    const m = line.match(/^\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(?:(\d{1,2}\/\d{1,2}\/\d{2,4})\s+)?(?:(\d{8,})\s+)?(.+?)\s+(-?\$?-?[\d,]+\.\d{2})\s*(CR)?\s*$/i);
    if (!m) continue;
    let amount = money(m[5]);
    if (m[6]) amount = -Math.abs(amount);
    out.transactions.push({
      trans: parseMDY(m[1]), post: m[2] ? parseMDY(m[2]) : null, ref: m[3] || null,
      desc: m[4].trim(), amount, src: src(paper, j, lines),
    });
  }
  return out;
}

// ---------------------------------------------------------- bank statement

function parseBankStatement(paper) {
  const text = paper.text, lines = text.split(/\r?\n/);
  const out = { kind: 'bank-statement', paperId: paper.id, transactions: [] };
  const firstLine = lines.findIndex(l => l.trim());
  if (firstLine >= 0) out.bank = { value: titleCase(lines[firstLine].trim()), src: src(paper, firstLine, lines) };
  let i = findLine(lines, /(checking|savings)/i);
  if (i >= 0) {
    const m = lines[i].match(/([A-Za-z ]*(?:checking|savings))\s*[-–—]?\s*account ending\s*(\d{3,4})/i);
    if (m) { out.accountType = m[1].trim(); out.ending = { value: m[2], src: src(paper, i, lines) }; }
    else out.accountType = (lines[i].match(/[A-Za-z ]*(checking|savings)/i) || [''])[0].trim();
  }
  i = findLine(lines, /statement period/i);
  let year = null, periodEnd = null;
  if (i >= 0) {
    const ds = [...lines[i].matchAll(/\d{1,2}\/\d{1,2}\/\d{2,4}/g)].map(m => parseMDY(m[0]));
    if (ds.length) { periodEnd = ds[ds.length - 1]; year = +periodEnd.slice(0, 4); out.period = { from: ds[0], to: periodEnd, src: src(paper, i, lines) }; }
  }
  const header = findLine(lines, /withdrawals/i);
  const depositCol = header >= 0 ? lines[header].search(/deposits/i) : -1;
  for (let j = header + 1; j < lines.length && j > 0; j++) {
    const line = lines[j];
    const m = line.match(/^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+(-?[\d,]+\.\d{2})\s*$/);
    if (!m) { if (/in case of errors/i.test(line)) break; continue; }
    const date = m[1].split('/').length === 3 ? parseMDY(m[1]) : parseMD(m[1], year);
    const amtEnd = line.lastIndexOf(m[3]) + m[3].length;
    const deposit = depositCol > 0 ? amtEnd > depositCol + 2 : /deposit/i.test(m[2]);
    let desc = m[2].trim();
    const card = desc.match(/\b(x\d{4})\s*$/i);
    out.transactions.push({ trans: date, post: date, desc, amount: deposit ? -money(m[3]) : money(m[3]),
      debitCard: /debit card/i.test(desc), cardHint: card ? card[1] : null, src: src(paper, j, lines) });
  }
  i = findLine(lines, /in case of errors/i);
  if (i >= 0) {
    out.errorNotice = { value: lines.slice(i, Math.min(lines.length, i + 4)).map(l => l.trim()).filter(Boolean).join(' '), src: src(paper, i, lines) };
  }
  return out;
}

// --------------------------------------------------------------- app lists

function parseAppList(paper, contextYear) {
  const text = paper.text, lines = text.split(/\r?\n/);
  const out = { kind: 'app-list', paperId: paper.id, transactions: [] };
  const head = lines.slice(0, 3).join(' ');
  const copied = head.match(/copied\s+(?:on\s+)?([^)]+?\d{4})/i);
  const copiedDate = copied ? parseLoose(copied[1]) : null;
  if (copiedDate) out.copied = { value: copiedDate, src: src(paper, 0, lines) };
  if (/credit card|available credit|credit limit/i.test(text)) {
    const k = findLine(lines, /credit card|available credit|credit limit/i);
    out.creditHint = src(paper, k, lines);
  }
  if (/debit card|checking/i.test(head)) out.debitHint = src(paper, 0, lines);
  const ending = text.match(/ending\s+(\d{4})/i);
  if (ending) out.ending = { value: ending[1], src: src(paper, findLine(lines, /ending\s+\d{4}/i), lines) };
  const datesArePosting = /date posted|posted date|posting date/i.test(text);
  const year = copiedDate ? { year: +copiedDate.slice(0, 4), notAfter: copiedDate } : { year: contextYear };
  let section = null;
  lines.forEach((line, j) => {
    if (/^\s*pending\s*$/i.test(line)) { section = 'pending'; return; }
    if (/^\s*posted\s*$/i.test(line)) { section = 'posted'; return; }
    const m = line.match(/^\s*([A-Z][a-z]{2,8}\.?\s+\d{1,2})\s+(.+?)\s+(-?\$-?[\d,]+\.\d{2})\s*(.*)$/);
    if (!m) return;
    const date = parseLoose(m[1], year);
    const tail = m[4] || '';
    let status = section || (/pending/i.test(tail) ? 'pending' : (/posted/i.test(tail) ? 'posted' : 'posted'));
    if (/pending/i.test(tail)) status = 'pending';
    const postedIn = tail.match(/posted\s*\(?\s*(?:on\s+)?([A-Z][a-z]{2,8}\.?\s+\d{1,2})\)?/i) || tail.match(/\(\s*([A-Z][a-z]{2,8}\.?\s+\d{1,2})\s*\)/);
    const tx = { desc: m[2].trim(), amount: money(m[3]), status, src: src(paper, j, lines) };
    if (postedIn) { tx.trans = date; tx.post = parseLoose(postedIn[1], year); }
    else if (datesArePosting) { tx.trans = null; tx.post = date; }
    else { tx.shown = date; tx.trans = null; tx.post = null; }
    out.transactions.push(tx);
  });
  return out;
}

// ------------------------------------------------------------------ emails

function header(lines, name) {
  const i = findLine(lines, new RegExp(`^\\s*${name}:`, 'i'));
  return i >= 0 ? { value: lines[i].replace(new RegExp(`^\\s*${name}:\\s*`, 'i'), '').trim(), line: i } : null;
}

function parseEmail(paper) {
  const text = paper.text, lines = text.split(/\r?\n/);
  const out = { kind: 'email', paperId: paper.id };
  const from = header(lines, 'From'), to = header(lines, 'To'), date = header(lines, '(?:Date|Sent)'), subject = header(lines, 'Subject');
  const fm = from && from.value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  out.from = from ? { name: fm ? fm[1].trim() : from.value.replace(/<.*>/, '').trim(), address: fm ? fm[2].trim() : (from.value.match(/\S+@\S+/) || [null])[0], src: src(paper, from.line, lines) } : null;
  const tm = to && to.value.match(/<([^>]+)>|(\S+@\S+)/);
  out.to = to ? { name: to.value.replace(/<.*>/, '').trim(), address: tm ? (tm[1] || tm[2]) : null, src: src(paper, to.line, lines) } : null;
  out.date = date ? { value: parseLoose(date.value), src: src(paper, date.line, lines) } : null;
  out.subject = subject ? subject.value : '';
  const bodyStart = Math.max(...[from, to, date, subject].filter(Boolean).map(h => h.line)) + 1;
  out.bodyStart = bodyStart;
  const body = lines.slice(bodyStart).join('\n');
  out.body = body.trim();
  const all = `${out.subject}\n${body}`;
  const sentDate = out.date && out.date.value;
  const yearHint = sentDate ? +sentDate.slice(0, 4) : null;
  const lineOf = re => { const k = findLine(lines, re, bodyStart); return k >= 0 ? src(paper, k, lines) : (subject && re.test(subject.value) ? src(paper, subject.line, lines) : null); };

  // Statement-ready notices are transmission evidence (R8a).
  if (/statement/i.test(all) && /(is (now )?(ready|available)|has been posted|now available)/i.test(all)) {
    out.statementReady = true;
    const e = all.match(/ending(?: in)?\s+(\d{3,4})/i);
    if (e) out.ending = e[1];
    const c = all.match(/closing date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (c) out.closingMentioned = parseMDY(c[1]);
    out.issuerName = out.from ? out.from.name : null;
    return out;
  }
  out.byPerson = !!out.from && (!out.from.address || /^\s*(me|i)\s*$/i.test(out.from.name));
  out.org = out.byPerson ? (out.to ? orgFromAddress(out.to) : null) : (out.from ? orgFromAddress(out.from) : null);

  if (/\b(cancel|cancell?ed|cancell?ation|deleted|auto-?renew|unsubscribe|close my account)\b/i.test(all)) {
    out.cancellation = {
      role: out.byPerson ? 'request' : 'confirmation',
      src: lineOf(/cancel|deleted|auto-?renew/i),
    };
    if (/please cancel|i('d| would) like to cancel|i want to cancel/i.test(all)) out.cancellation.role = 'request';
    const eff = all.match(/effective\s+(today|immediately|\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (eff) {
      const v = /today|immediately/i.test(eff[1]) ? sentDate : parseLoose(eff[1], yearHint);
      if (v) out.cancellation.effective = { value: v, src: lineOf(/effective/i), words: eff[0] };
    }
    const end = all.match(/(?:access|plan|membership|subscription)\s+(?:ends|will end)(?:\s+on)?\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (end) out.cancellation.ends = { value: parseLoose(end[1], yearHint), src: lineOf(/ends|will end/i), words: end[0] };
    const promise = all.match(/(won'?t|will not|no (further|future)) (be )?(charged|billed|charges|renew)[^.\n]*/i);
    if (promise) out.cancellation.promise = { words: promise[0].trim(), sentence: (() => { const b = body.match(/(won'?t|will not|no (further|future)) (be )?(charged|billed|charges|renew)/i); return b ? sentenceAround(body.trim(), body.trim().search(/(won'?t|will not|no (further|future)) (be )?(charged|billed|charges|renew)/i)) : null; })(), src: lineOf(/(won'?t|will not|no (further|future))/i) };
    const quote = body.split(/\r?\n/).map(s => s.trim()).find(s => /(cancel|deleted)/i.test(s) && s.length > 12);
    if (quote) out.cancellation.quote = quote;
  }
  const refund = all.match(/(?:issued|processed|sent)\s+(?:you\s+)?a\s+(?:full\s+|partial\s+)?refund\s+of\s+(\$[\d,]+\.\d{2})(?:\s+for\s+(?:your|the)\s+([A-Za-z]+)\s+charge)?([^.\n]*)/i);
  if (refund && !out.byPerson) {
    out.refundPromise = { amount: money(refund[1]), month: refund[2] || null,
      date: /\btoday\b/i.test(refund[0] + refund[3]) ? sentDate : (parseLoose(refund[3], yearHint) || sentDate),
      words: refund[0].trim(), src: lineOf(/refund/i) };
  }
  const credit = all.match(/credit(?:ed)?\s+(\$[\d,]+\.\d{2})\s+(?:toward|towards|to|against)\s+(?:your|the)\s+([A-Za-z]+)\s+charge/i);
  if (credit && !out.byPerson) out.creditNote = { amount: money(credit[1]), month: credit[2], words: credit[0], src: lineOf(/credit/i) };

  // A merchant's account of the contract: notice periods, fees, a final date.
  if (!out.byPerson) {
    const claims = [];
    const notice = all.match(/(\d+)\s+days'?\s+(?:written\s+)?notice/i);
    if (notice) claims.push({ kind: 'notice-period', days: +notice[1], words: sentenceAround(all, notice.index), src: lineOf(/notice/i) });
    const fee = all.match(/(early termination|cancellation|termination)\s+fee\s+of\s+(\$[\d,]+\.\d{2})/i);
    if (fee) claims.push({ kind: 'fee', amount: money(fee[2]), words: sentenceAround(all, fee.index), src: lineOf(/fee/i) });
    const fin = all.match(/final\s+(?:monthly\s+)?(?:dues|charge|payment|bill)\s+will\s+be\s+(?:charged|billed)\s+on\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}|[A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4})/i);
    if (fin) claims.push({ kind: 'final-date', date: parseLoose(fin[1], yearHint), words: sentenceAround(all, fin.index), src: lineOf(/final/i) });
    const term = all.match(/(\d+)-month term/i);
    if (term) claims.push({ kind: 'term', words: sentenceAround(all, term.index), src: lineOf(/term/i) });
    if (claims.length) out.contractClaims = claims;
  }
  if (!out.cancellation && !out.refundPromise && !out.creditNote && !out.byPerson && /^re:/i.test(out.subject)) {
    out.merchantReply = { words: body.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '', src: lineOf(/\S/) };
  }
  return out;
}

function sentenceAround(text, index) {
  const flat = text.replace(/\s*\n\s*/g, ' ');
  const offset = text.slice(0, index).replace(/\s*\n\s*/g, ' ').length;
  const startIdx = Math.max(flat.lastIndexOf('. ', offset) + 2, flat.lastIndexOf(', ', offset) > flat.lastIndexOf('. ', offset) ? 0 : 0);
  const endMatch = flat.slice(offset).match(/\.(\s|$)/);
  const endIdx = endMatch ? offset + endMatch.index : -1;
  return flat.slice(startIdx >= 2 ? startIdx : 0, endIdx >= 0 ? endIdx + 1 : undefined).trim();
}

function orgFromAddress(party) {
  const name = party.name && !/@/.test(party.name) ? party.name : null;
  const domain = party.address ? party.address.split('@')[1] : null;
  const label = domain ? domain.split('.')[0] : null;
  return { name, domainLabel: label };
}

// ------------------------------------------------------- other and notes

function parseOther(paper) {
  const text = paper.text, lines = text.split(/\r?\n/);
  const out = { kind: 'other', paperId: paper.id };
  const d = text.match(/(?:taken|captured|dated|on)\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i);
  if (d) out.date = { value: parseLoose(d[1]), src: src(paper, findLine(lines, new RegExp(d[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))), lines) };
  if (/auto-?renew\s*:?\s*off|turned off auto-?renew|cancel/i.test(text) || /won'?t be charged again/i.test(text)) {
    const k = findLine(lines, /auto-?renew|cancel|won'?t be charged/i);
    out.cancellation = { role: 'record', src: src(paper, k, lines), quote: lines[k].trim() };
    const promise = text.match(/(won'?t|will not) be (charged|billed)[^."\n]*/i);
    if (promise) out.cancellation.promise = { words: promise[0], src: src(paper, findLine(lines, /won'?t be|will not be/i), lines) };
    const end = text.match(/will end on\s+(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})/i);
    if (end) out.cancellation.ends = { value: parseLoose(end[1]), words: end[0], src: src(paper, findLine(lines, /will end on/i), lines) };
  }
  // Names the record carries ("Glasswing account settings")
  out.names = [...new Set((text.match(/\b[A-Z][a-z]{4,}\b/g) || []))];
  return out;
}

function parseNote(paper) {
  const lines = paper.text.split(/\r?\n/);
  return { kind: 'own-note', paperId: paper.id, date: { value: parseLoose(lines[0]), src: src(paper, 0, lines) }, text: lines.slice(1).join('\n').trim() };
}

export function parsePaper(paper, contextYear) {
  const kind = paper.kindOverride || classify(paper.text);
  switch (kind) {
    case 'card-statement': return parseCardStatement(paper);
    case 'bank-statement': return parseBankStatement(paper);
    case 'app-list': return parseAppList(paper, contextYear);
    case 'email': return parseEmail(paper);
    case 'own-note': return parseNote(paper);
    default: return parseOther(paper);
  }
}

export const KIND_LABELS = {
  'card-statement': 'credit card statement',
  'bank-statement': 'bank account statement',
  'app-list': 'list copied from an app or website',
  email: 'email',
  'own-note': 'your own note',
  other: 'other record',
};

function titleCase(s) {
  const t = String(s || '').trim();
  if (t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\bP\.o\./g, 'P.O.');
}

export { isIso };
