// The case: papers in, a correctable reconstruction out.
// Rule numbers (R1-R26, U1-U8) refer to RECEIVER_CONTRACT.md at the
// candidate root. Every result is recomputed from the papers plus the
// person's corrections and choices, so a corrected fact reaches every output.

import { parsePaper, compact, money } from './papers.mjs';
import { addDays, diffDays, addMonths, fmt, isIso, monthNumber, iso, parseLoose } from './dates.mjs';

export const FORMAT = 'charged-after-cancelling-case';
export const VERSION = 1;

export function emptyState() {
  return { format: FORMAT, version: VERSION, papers: [], corrections: {}, choices: {}, savedAt: null, snapshot: null };
}

const NOT_MERCHANT = /^(PAYMENT|PAYMENT RECEIVED|PAYMENT - THANK YOU|PAYMENT THANK YOU|AUTOPAY|ONLINE PAYMENT)\b|^PAYMENT\b/i;
const CARD_CHARGE = /(INTEREST CHARGE|FINANCE CHARGE|^LATE (PAYMENT )?FEE|^ANNUAL FEE|^RETURNED PAYMENT FEE|^OVER.?LIMIT FEE)/i;
const TEMP_CREDIT = /(TEMPORARY|PROVISIONAL)\s+CREDIT/i;
const PAY_SERVICE = /^([A-Z]{2,12})\s?\*/;

export function groupKey(desc) {
  let d = String(desc || '').toUpperCase().replace(/^DEBIT CARD PURCHASE\s+/, '').replace(/^(POS|PURCHASE|RECURRING)\s+/, '');
  d = d.replace(/\bx\d{4}\b/gi, '').replace(/[#*]\S*/g, ' ').replace(/\b\d[\d-]*\b/g, ' ').replace(/\s+/g, ' ').trim();
  const words = d.split(' ').filter(Boolean);
  if (!words.length) return compact(desc);
  return words[0].length >= 4 ? compact(words[0]) : compact(words.slice(0, 2).join(' '));
}

function titled(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase());
}

export function dollars(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'unknown amount';
  const s = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '-' : ''}$${s}`;
}

function fact(state, id, extracted, src) {
  const c = state.corrections || {};
  const has = Object.prototype.hasOwnProperty.call(c, id);
  return { id, value: has ? c[id].value : extracted, extracted, src: src || null, corrected: has && c[id].value !== extracted };
}

// ------------------------------------------------------------------ windows

// R7-R10: the notice must ARRIVE no later than 60 days after the first
// statement reflecting the item was transmitted. Only transmission starts
// the clock; when it is unknown, the closing date is the earliest possible
// transmission and (due - 21) the latest plausible one.
export function statementWindow(st, today) {
  const why = [];
  const closing = st.closing && st.closing.value;
  const due = st.due && st.due.value;
  const tx = st.transmitted && st.transmitted.value;
  if (tx) {
    const arriveBy = addDays(tx, 60);
    const daysLeft = diffDays(arriveBy, today);
    why.push(`Your statement closing ${fmt(closing)} was sent on ${fmt(tx)} (${st.transmitted.basis}). The notice must arrive within 60 days after that: by ${fmt(arriveBy)}.`);
    return { basis: 'transmission', start: tx, arriveBy, daysLeft, status: daysLeft < 0 ? 'closed' : 'open', why };
  }
  if (!closing) {
    why.push('The closing date of this statement is not known, so its 60 days cannot be counted. Add the statement or correct its closing date.');
    return { basis: 'none', status: 'unknown', why };
  }
  const earliest = addDays(closing, 60);
  let latest = due ? addDays(addDays(due, -21), 60) : null;
  if (latest && latest < earliest) latest = earliest;
  why.push(`Your papers do not show the day this statement was sent. It cannot have gone out before it closed on ${fmt(closing)}, so the notice has at least until ${fmt(earliest)} to arrive. The true deadline may be later.`);
  if (latest) why.push(`Card companies must have procedures to send statements at least 21 days before the payment due date (${fmt(due)}), so the latest plausible sending day gives ${fmt(latest)}. That is a procedures rule, not a guarantee.`);
  if (diffDays(earliest, today) >= 0) {
    return { basis: 'closing-bound', start: closing, earliest, latest, arriveBy: earliest, daysLeft: diffDays(earliest, today), status: 'open-at-least', why };
  }
  if (latest && diffDays(latest, today) < 0) {
    return { basis: 'closing-bound', start: closing, earliest, latest, status: 'closed-bound', why };
  }
  why.push(latest
    ? `Today is between those two dates, so it may already be too late. A dated "statement is ready" notice for this statement would settle it.`
    : `Without the payment due date the latest plausible date cannot be worked out, so it may already be closed.`);
  return { basis: 'closing-bound', start: closing, earliest, latest, status: 'may-be-closed', why };
}

// Short labels; deadlineText() in outputs.mjs says the rest, never repeating them.
export const STATUS_LABEL = {
  open: 'Open',
  'open-at-least': 'Open (exact deadline not known)',
  'may-be-closed': 'May be too late',
  closed: '60 days have passed',
  'closed-bound': '60 days have passed, by any date the statement could reasonably have been sent',
  'not-started': 'Not on a statement yet',
  pending: 'Pending: not on your account yet',
  unknown: 'Deadline not known',
  credited: 'Credited in full',
  exit: 'Not handled here',
};

export function isOpenStatus(s) {
  return s === 'open' || s === 'open-at-least';
}
export function isClosedStatus(s) {
  return s === 'closed' || s === 'closed-bound';
}

// ------------------------------------------------------------------ analyze

export function analyze(state, today) {
  if (!isIso(today)) throw new Error('analyze needs today as YYYY-MM-DD');
  const choices = state.choices || {};
  const year = +today.slice(0, 4);
  const papers = state.papers || [];
  const parsed = papers.map(p => ({ paper: p, data: parsePaper(p, year) }));
  const byKind = k => parsed.filter(x => x.data.kind === k).map(x => x.data);
  const paperName = Object.fromEntries(papers.map(p => [p.id, p.name || p.id]));
  const result = {
    today, paperName, parsed, questions: [], warnings: [], missing: [], conflicts: [],
    timeline: [], items: [], beforeCancel: [], otherCharges: [], credits: [], exit: null,
  };

  // ---- statements (corrected) and transmission evidence (R8a)
  const ready = byKind('email').filter(e => e.statementReady);
  const statements = byKind('card-statement').map(s => {
    const id = `st:${s.paperId}`;
    const st = {
      id, paperId: s.paperId, raw: s,
      closing: fact(state, `${id}:closing`, s.closing && s.closing.value, s.closing && s.closing.src),
      due: fact(state, `${id}:due`, s.due && s.due.value, s.due && s.due.src),
      opening: s.opening || null,
    };
    let evidence = null;
    if (st.closing.value) {
      const cands = ready.filter(e => e.date && e.date.value && (!e.ending || !s.ending || e.ending === s.ending.value) &&
        (e.closingMentioned ? e.closingMentioned === st.closing.value
          : diffDays(e.date.value, st.closing.value) >= 0 && diffDays(e.date.value, st.closing.value) <= 10))
        .sort((a, b) => a.date.value.localeCompare(b.date.value));
      if (cands.length) evidence = cands[0];
    }
    const t = fact(state, `${id}:transmitted`, evidence ? evidence.date.value : null, evidence ? evidence.date.src : null);
    if (t.value) {
      st.transmitted = { value: t.value, src: t.src, corrected: t.corrected, id: t.id, extracted: t.extracted,
        basis: t.corrected && !evidence ? 'the date you entered' : (t.corrected ? 'the date you corrected' : `the "statement is ready" email from ${evidence.from ? evidence.from.name : 'your bank'}`) };
    } else st.transmitted = { value: null, id: t.id, corrected: t.corrected, extracted: t.extracted };
    st.label = `statement closing ${fmt(st.closing.value)}`;
    return st;
  }).sort((a, b) => String(a.closing.value).localeCompare(String(b.closing.value)));
  result.statements = statements;
  // Statements the papers show exist but do not include. A charge on one is
  // invisible here, but its window is not: a "statement is ready" email dates
  // it (R8a), and the closing dates either side bound it (R8b). The page never
  // invents the charge; it says what a charge on it would have (cold walk 1).
  const missingStatements = [];
  for (let i = 1; i < statements.length; i++) {
    const prev = statements[i - 1], cur = statements[i];
    const nextOpen = cur.opening && cur.opening.value;
    if (prev.closing.value && nextOpen && diffDays(nextOpen, prev.closing.value) > 1) {
      const from = addDays(prev.closing.value, 1), to = addDays(nextOpen, -1);
      // One cycle missing: its closing is the day before the next one opens.
      const one = diffDays(to, from) <= 35;
      missingStatements.push({ from, to, closing: one ? to : null, several: !one, sent: null, src: null });
    }
  }
  for (const e of ready) {
    if (statements.some(st => st.transmitted.src && st.transmitted.src.paper === e.paperId)) continue;
    if (!e.date || !e.date.value) continue;
    const sent = e.date.value;
    const gap = missingStatements.find(m => !m.sent && m.closing && (e.closingMentioned ? e.closingMentioned === m.closing
      : diffDays(sent, m.closing) >= 0 && diffDays(sent, m.closing) <= 10));
    if (gap) { gap.sent = sent; gap.src = e.date.src; } else missingStatements.push({ from: null, to: null, closing: e.closingMentioned || null, several: false, sent, src: e.date.src });
  }
  for (const m of missingStatements) {
    if (m.sent) {
      const arriveBy = addDays(m.sent, 60), daysLeft = diffDays(arriveBy, today);
      m.window = { basis: 'transmission', status: daysLeft < 0 ? 'closed' : 'open', arriveBy, daysLeft };
    } else {
      const earliest = addDays(m.closing || m.from, 60), daysLeft = diffDays(earliest, today);
      m.window = daysLeft >= 0 ? { basis: 'closing-bound', status: 'open-at-least', earliest, arriveBy: earliest, daysLeft }
        : { basis: 'closing-bound', status: 'may-be-closed', earliest };
    }
    m.soon = isOpenStatus(m.window.status) && m.window.daysLeft <= 10;
  }
  missingStatements.sort((a, b) => String(a.window.arriveBy || a.window.earliest).localeCompare(String(b.window.arriveBy || b.window.earliest)));
  result.missingStatements = missingStatements;

  // ---- account, payment method (R1-R5)
  const cardStatements = byKind('card-statement');
  const banks = byKind('bank-statement');
  const apps = byKind('app-list');
  const endings = new Set([...cardStatements, ...apps].map(x => x.ending && x.ending.value).filter(Boolean));
  if (endings.size > 1) result.warnings.push({ text: `Your papers show more than one card (ending ${[...endings].join(', ')}). This page works on one card at a time; remove the papers for the others or start a separate case for each.` });
  const firstStatement = cardStatements[0];
  const nameFact = fact(state, 'person:name', firstStatement && firstStatement.cardholder ? firstStatement.cardholder.value
    : (byKind('email').map(e => e.byPerson ? e.from && e.from.name : e.to && e.to.name).find(n => n && !/@/.test(n)) || ''), firstStatement && firstStatement.cardholder && firstStatement.cardholder.src);
  result.account = {
    issuer: firstStatement && firstStatement.issuer ? firstStatement.issuer.value : null,
    product: firstStatement ? firstStatement.product : null,
    ending: endings.size ? [...endings][0] : (banks[0] && banks[0].ending ? banks[0].ending.value : null),
    name: nameFact,
  };
  let method = { value: null, why: '', src: null };
  const minLine = cardStatements.find(s => s.minimum);
  if (cardStatements.some(s => s.businessHint)) method = { value: 'business', why: 'The statement names a business or corporate card.', src: cardStatements.find(s => s.businessHint).issuer.src };
  else if (cardStatements.some(s => s.prepaidHint)) method = { value: 'prepaid', why: 'The statement names a prepaid card.', src: null };
  else if (minLine) method = { value: 'credit', why: 'Your statement shows a minimum payment due and a payment due date, so it is a credit card account.', src: minLine.minimum.src };
  else if (banks.length && banks.some(b => b.transactions.some(t => t.debitCard))) {
    const b = banks.find(x => x.transactions.some(t => t.debitCard));
    method = { value: 'debit', why: `Your statement is for a ${b.accountType || 'bank'} account and lists "DEBIT CARD PURCHASE", with no minimum payment due. That is a debit card, not a credit card.`, src: b.transactions.find(t => t.debitCard).src };
  } else if (apps.some(a => a.creditHint)) method = { value: 'credit', why: 'Your app screen says "Credit card" or shows available credit. No statement was added to confirm it.', src: apps.find(a => a.creditHint).creditHint, inferred: true };
  else if (apps.some(a => a.debitHint)) method = { value: 'debit', why: 'Your app screen names a debit card or checking account.', src: apps.find(a => a.debitHint).debitHint };
  const methodFact = fact(state, 'account:method', method.value, method.src);
  result.method = { ...method, value: methodFact.value, corrected: methodFact.corrected, id: 'account:method' };
  if (methodFact.corrected) result.method.why = 'You said so.';
  if (!result.method.value && papers.length) {
    result.questions.push({ id: 'account:method', kind: 'method', text: 'Does your statement show a minimum payment due?',
      why: 'The credit-card rules this page uses apply only to a credit card. A debit card follows different rules.',
      options: [['credit', 'Yes: it is a credit card'], ['debit', 'No: it is a debit card or bank account'], ['business', 'It is a business or company card'], ['prepaid', 'It is a prepaid card']] });
  }

  // ---- charges from every source, deduplicated
  const statementTx = [];
  for (const st of statements) {
    for (const [k, t] of st.raw.transactions.entries()) {
      const id = `tx:${st.paperId}:${t.src.line}`;
      statementTx.push({
        id, source: 'statement', statementId: st.id, desc: t.desc, ref: t.ref, src: t.src, index: k,
        trans: fact(state, `${id}:trans`, t.trans, t.src), post: fact(state, `${id}:post`, t.post, t.src),
        amount: fact(state, `${id}:amount`, t.amount, t.src), status: 'posted',
      });
    }
  }
  const otherTx = [];
  for (const a of apps) for (const t of a.transactions) {
    const id = `tx:${a.paperId}:${t.src.line}`;
    otherTx.push({ id, source: 'app', desc: t.desc, src: t.src, status: t.status, shown: t.shown || null,
      trans: fact(state, `${id}:trans`, t.trans, t.src), post: fact(state, `${id}:post`, t.post, t.src),
      amount: fact(state, `${id}:amount`, t.amount, t.src) });
  }
  for (const b of banks) for (const t of b.transactions) {
    const id = `tx:${b.paperId}:${t.src.line}`;
    otherTx.push({ id, source: 'bank', desc: t.desc, src: t.src, status: 'posted', debitCard: t.debitCard,
      trans: fact(state, `${id}:trans`, t.trans, t.src), post: fact(state, `${id}:post`, t.post, t.src),
      amount: fact(state, `${id}:amount`, t.amount, t.src) });
  }
  const dateOf = t => t.trans.value || t.post.value || t.shown;
  const sameCharge = (a, b) => groupKey(a.desc) === groupKey(b.desc) && a.amount.value === b.amount.value &&
    [a.trans.value, a.post.value, a.shown].filter(Boolean).some(x => [b.trans.value, b.post.value, b.shown].filter(Boolean).some(y => Math.abs(diffDays(x, y)) <= 3));
  const all = [...statementTx];
  for (const t of otherTx) {
    if (t.source === 'app' && t.status === 'posted' && all.some(s => sameCharge(s, t))) continue;
    if (t.source === 'app' && t.status === 'pending' && all.some(s => s.status === 'pending' && sameCharge(s, t))) continue;
    all.push(t);
  }

  // ---- merchants named by the cancellation papers
  const evidencePapers = parsed.filter(x => x.data.cancellation || x.data.refundPromise || x.data.creditNote || x.data.contractClaims || x.data.merchantReply);
  const tokensOf = d => {
    const out = new Set();
    if (d.org) { if (d.org.name) out.add(compact(d.org.name)); if (d.org.domainLabel) out.add(compact(d.org.domainLabel)); }
    if (d.org && d.org.name) d.org.name.split(/\s+/).forEach(w => out.add(compact(w)));
    const text = [d.cancellation && d.cancellation.quote, d.subject].filter(Boolean).join(' ');
    (text.match(/\b[A-Z][A-Za-z]{4,}\b/g) || []).forEach(w => out.add(compact(w)));
    (d.names || []).forEach(w => out.add(compact(w)));
    return [...out].filter(t => t.length >= 5 && !/^(your|subscription|cancel\w*|membership|account|please|thanks)$/.test(t));
  };
  const merchantCharges = all.filter(t => t.amount.value !== null && !NOT_MERCHANT.test(t.desc) && !CARD_CHARGE.test(t.desc));
  const groups = {};
  for (const t of merchantCharges) (groups[groupKey(t.desc)] ||= []).push(t);
  const groupEvidence = {};
  for (const x of evidencePapers) {
    const toks = tokensOf(x.data);
    for (const [key, list] of Object.entries(groups)) {
      if (list.some(t => toks.some(tok => compact(t.desc).includes(tok) || (tok.length >= 6 && tok.includes(key) && key.length >= 5)))) {
        (groupEvidence[key] ||= []).push(x.data);
      }
    }
  }
  const chosen = choices.merchants || {};
  let merchantKeys = Object.keys(groupEvidence).filter(k => chosen[k] !== false);
  for (const [k, v] of Object.entries(chosen)) if (v === true && groups[k] && !merchantKeys.includes(k)) merchantKeys.push(k);
  if (!merchantKeys.length && Object.keys(groups).length) {
    result.questions.push({ id: 'merchants', kind: 'merchant', text: 'Which of these is the business you cancelled?',
      why: 'None of your papers names the business in a way that matches a line on your statements, so the page cannot tell which charges you mean.',
      options: Object.entries(groups).filter(([, l]) => l.some(t => t.amount.value > 0)).map(([k, l]) => [k, `${l[0].desc} (${l.length} line${l.length > 1 ? 's' : ''})`]) });
  }
  const merchantName = key => {
    const ev = (groupEvidence[key] || []).find(d => d.org && d.org.name);
    if (ev) return ev.org.name;
    // "my Pantry Box subscription", "Glasswing account settings"
    for (const d of groupEvidence[key] || []) {
      const text = parsed.find(x => x.data.paperId === d.paperId).paper.text;
      for (const m of text.matchAll(/\b((?:[A-Z][\w'&]+)(?:\s+[A-Z][\w'&]+){0,2})\s+(?:account|subscription|membership|plan)\b/g)) {
        const name = m[1].replace(/^(My|Your|The|Our|Cancel|Please)\s+/, '');
        if (!/^(My|Your|The|Our|Cancel|Please)$/.test(name) && groups[key].some(t => compact(t.desc).includes(compact(name.split(/\s+/)[0])))) return name;
      }
    }
    return titled(groups[key][0].desc.replace(/^DEBIT CARD PURCHASE\s+/i, '').replace(/\s+(ZZ|x\d{4}).*$/i, '').replace(/\s+\d[\d-]+.*$/, ''));
  };
  result.merchants = merchantKeys.map(k => ({ key: k, name: merchantName(k), evidence: (groupEvidence[k] || []).map(d => d.paperId) }));

  // The missing statements, in words. The text is the gap note and, when it
  // matters, the most urgent thing on the page.
  const whoCharges = result.merchants.length ? result.merchants.map(m => m.name).join(' or ') : 'the business you cancelled';
  for (const m of missingStatements) {
    const w = m.window;
    const parts = [];
    if (m.from) parts.push(`No statement in your papers covers ${fmt(m.from)} to ${fmt(m.to)}.${m.several ? ' More than one statement may be missing.' : ''}`);
    if (m.sent) parts.push(m.from ? `Your "statement is ready" email shows the statement for that period was sent on ${fmt(m.sent)}.`
      : `Your "statement is ready" email of ${fmt(m.sent)} announces a statement that is not in your papers.`);
    const subject = m.several ? 'the first of those statements' : 'that statement';
    if (w.status === 'open') parts.push(`If ${subject} shows a charge from ${whoCharges}, a notice about that charge has to arrive by ${fmt(w.arriveBy)} (${w.daysLeft === 0 ? 'today is the last day' : `${w.daysLeft} day${w.daysLeft === 1 ? '' : 's'} left`}).`);
    else if (w.status === 'closed') parts.push(`The 60 days for a charge on it ended on ${fmt(w.arriveBy)}. You can still ask about such a charge (see "Older charges").`);
    else if (w.status === 'open-at-least') parts.push(`It closed ${m.several ? 'no earlier than' : 'on'} ${fmt(m.closing || m.from)}, but the day it was sent is not in your papers. If ${subject} shows a charge from ${whoCharges}, a notice about that charge has at least until ${fmt(w.earliest)} to arrive (${w.daysLeft} day${w.daysLeft === 1 ? '' : 's'} left); the true deadline may be later.`);
    else parts.push(`It closed ${m.several ? 'no earlier than' : 'on'} ${fmt(m.closing || m.from)}. A notice about a charge on it had at least until ${fmt(w.earliest)}, which has passed, so it may already be too late for one. A dated "statement is ready" email would settle it.`);
    parts.push(isOpenStatus(w.status) ? 'Add that statement if you have it; the page will then match the charge and draft the notice.' : 'Add that statement if you have it, so any charge on it is in your record.');
    m.text = parts.join(' ');
    result.missing.push({ text: m.text, src: m.src, statement: m });
  }

  // ---- cancellation facts
  const cancelEvidence = [];
  for (const x of parsed) {
    const d = x.data;
    if (!d.cancellation) continue;
    const date = d.kind === 'email' ? d.date && d.date.value : d.date && d.date.value;
    cancelEvidence.push({ paperId: d.paperId, role: d.cancellation.role, date, src: d.cancellation.src || (d.date && d.date.src),
      effective: d.cancellation.effective, ends: d.cancellation.ends, promise: d.cancellation.promise, quote: d.cancellation.quote,
      by: d.kind === 'email' ? (d.byPerson ? 'you' : (d.from && d.from.name)) : 'record', kind: d.kind });
  }
  cancelEvidence.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!cancelEvidence.length) {
    const words = [state.ownWords || '', ...byKind('own-note').map(n => n.text)].join('\n');
    const m = words.match(/cancel\w*\b[^.\n]{0,60}?\bon\s+(\d{1,2}\s+[A-Za-z]{3,9}(?:\s+\d{4})?|[A-Za-z]{3,9}\s+\d{1,2}(?:,?\s+\d{4})?)/i);
    const d = m ? parseLoose(m[1], { year, notAfter: today }) : null;
    if (d) cancelEvidence.push({ paperId: null, role: 'own-words', date: d, src: null, quote: m[0], by: 'you', kind: 'own-words' });
  }
  const earliest = cancelEvidence.find(c => c.date);
  const cancelDate = fact(state, 'cancel:date', earliest ? earliest.date : null, earliest ? earliest.src : null);
  const confirmation = cancelEvidence.find(c => c.role === 'confirmation');
  result.cancellation = { date: cancelDate, evidence: cancelEvidence, confirmation: confirmation || null,
    basis: earliest ? (earliest.kind === 'own-words' ? 'your own words; no cancellation record is in your papers' : earliest.kind === 'other' ? `the date of your record (${paperName[earliest.paperId]}); you cancelled on or before it` : (earliest.role === 'request' ? 'the date you asked to cancel' : 'the date of the cancellation email')) : null };
  // Two cancellation dates (cold walk 3): the day the person cancelled, and a
  // later day the business's own paper gives for the end ("effective 30 June",
  // "access ends 30 Sep"). The page counts from the first and says so; it does
  // not decide which is legally right. A charge between them is not proposed.
  // "Effective X" with "not billed after that date" leaves X itself in doubt;
  // "ends on X" is the renewal day the person turned off, so X is not between.
  const ends = cancelEvidence.flatMap(c => [
    c.effective && { date: c.effective.value, kind: 'effective', words: c.effective.words, src: c.effective.src, by: c.by, paperId: c.paperId },
    c.ends && { date: c.ends.value, kind: 'ends', words: c.ends.words, src: c.ends.src, by: c.by, paperId: c.paperId },
  ]).filter(x => x && x.date && cancelDate.value && x.date > cancelDate.value).sort((a, b) => a.date.localeCompare(b.date));
  result.cancellation.until = ends.length ? ends[ends.length - 1] : null;
  if (result.cancellation.until) {
    const u = result.cancellation.until;
    u.who = u.by === 'you' ? 'your own message' : (u.by === 'record' || !u.by ? `your record (${paperName[u.paperId] || 'a paper'})` : `${u.by}'s message`);
  }
  const between = d => {
    const u = result.cancellation.until;
    return !!(u && d && d > cancelDate.value && (u.kind === 'effective' ? d <= u.date : d < u.date));
  };
  if (!cancelEvidence.length && papers.length) {
    result.missing.push({ text: 'No cancellation record is in your papers (a confirmation email, your request, or a screenshot). Your notice is stronger with one; add it if you have it.' });
  } else if (cancelEvidence.length && !confirmation && cancelEvidence.every(c => c.role === 'request')) {
    result.missing.push({ note: true, text: `Your papers show your request to cancel (${fmt(cancelEvidence[0].date)}) but no reply from the business confirming it. That gap stays visible; it is yours to judge.` });
  }
  if (!cancelDate.value && merchantKeys.length) {
    result.questions.push({ id: 'cancel:date', kind: 'date', text: 'On what date did you cancel?',
      why: 'The page proposes the charges made after that date. Without it, every charge from the business is listed and none is proposed.' });
  }

  // ---- contract claims (R26, section 6)
  const claims = evidencePapers.flatMap(x => (x.data.contractClaims || []).map(c => ({ ...c, paperId: x.data.paperId })));
  result.contract = claims.length ? {
    claims,
    finalDate: (claims.find(c => c.kind === 'final-date') || {}).date || null,
    fee: (claims.find(c => c.kind === 'fee') || {}).amount || null,
    personSays: cancelEvidence.find(c => c.role === 'request') || earliest || null,
  } : null;

  // ---- statement lookup and windows
  const lastStatement = statements.filter(s => s.closing.value).slice(-1)[0] || null;
  const stById = Object.fromEntries(statements.map(s => [s.id, s]));
  const closingDay = fact(state, 'account:closingDay', null, null).value;
  const synthStatement = postDate => {
    const day = Number(closingDay);
    if (!(day >= 1 && day <= 31) || !postDate) return null;
    let y = +postDate.slice(0, 4), m = +postDate.slice(5, 7);
    for (let k = 0; k < 3; k++) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const c = iso(y, m, Math.min(day, last));
      if (c >= postDate) return { id: `syn:${c}`, synthetic: true, closing: { value: c }, due: { value: null }, transmitted: { value: null }, label: `statement closing ${fmt(c)} (from the closing day you entered)` };
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return null;
  };

  const windowForCharge = (t) => {
    if (t.status === 'pending') {
      return { status: 'pending', why: ['This charge is still pending. A charge becomes a billing error only once it appears on a statement. Check again after your next statement.'] };
    }
    if (t.statementId) {
      const st = stById[t.statementId];
      return { ...statementWindow(st, today), statement: st };
    }
    const d = t.post.value || t.trans.value || t.shown;
    if (lastStatement && d) {
      if (d > lastStatement.closing.value) {
        const next = addMonths(lastStatement.closing.value, 1);
        return { status: 'not-started', recheckAfter: next,
          why: [`This charge is after your latest statement in your papers (closing ${fmt(lastStatement.closing.value)}), so it is not on a statement yet and its 60 days have not started. Your next statement should close around ${fmt(next)}; check it then.`] };
      }
      return { status: 'unknown', why: [`This charge is dated ${fmt(d)}, but none of the statements in your papers lists it. Add the statement that covers that date.`] };
    }
    const syn = synthStatement(t.post.value || t.trans.value || t.shown);
    if (syn) {
      if (syn.closing.value > today) return { status: 'not-started', recheckAfter: syn.closing.value, why: [`With the closing day you gave, this charge goes on the statement closing ${fmt(syn.closing.value)}, which has not closed yet.`] };
      const w = statementWindow(syn, today);
      return { ...w, statement: syn, why: [`Using the closing day you gave, this charge is on the statement closing ${fmt(syn.closing.value)}.`, ...w.why] };
    }
    // R9: no statement at all. Posting is an even earlier bound.
    const bound = t.post.value || t.trans.value || t.shown;
    if (!bound) return { status: 'unknown', why: ['No date is known for this charge.'] };
    const label = t.post.value ? 'posted' : (t.trans.value ? 'made' : 'shown in your app');
    const earliestBy = addDays(bound, 60);
    const age = diffDays(today, bound);
    const why = [`There is no statement in your papers, so the day its 60 days started is not known. The charge was ${label} on ${fmt(bound)}; the statement showing it cannot have been sent before then, so ${fmt(earliestBy)} is the earliest possible deadline, never a firm one.`];
    if (age <= 31) {
      // R6/U3: a charge becomes a billing error once a statement shows it, so a
      // charge that may not be on one yet is kept but not proposed for the notice.
      why.push('It is recent enough that it may not be on a statement yet. A charge becomes a billing error once a statement shows it, so the page does not propose it for the notice. Check your next statement, or choose to include it.');
      return { status: 'unknown', recent: true, basis: 'posting-bound', earliest: earliestBy, why, ask: 'closing' };
    }
    if (diffDays(earliestBy, today) >= 0) return { status: 'open-at-least', basis: 'posting-bound', arriveBy: earliestBy, earliest: earliestBy, daysLeft: diffDays(earliestBy, today), why, ask: 'closing' };
    why.push('That earliest date has passed, but the true deadline may still be ahead. The statement closing date would tell.');
    return { status: 'unknown', basis: 'posting-bound', earliest: earliestBy, why, ask: 'closing' };
  };

  // ---- credits and promised refunds
  const merchantSet = new Set(merchantKeys);
  const merchantCredits = all.filter(t => t.amount.value < 0 && merchantSet.has(groupKey(t.desc)) && !NOT_MERCHANT.test(t.desc));
  const positives = all.filter(t => t.amount.value > 0 && merchantSet.has(groupKey(t.desc)));
  const creditNotes = evidencePapers.filter(x => x.data.creditNote).map(x => x.data);
  const applied = {};
  const creditFor = choices.creditFor || {};
  for (const c of merchantCredits) {
    const amt = Math.abs(c.amount.value);
    const temporary = TEMP_CREDIT.test(c.desc);
    let target = null, basis = null;
    if (creditFor[c.id] !== undefined) { target = creditFor[c.id] || null; basis = 'you chose'; }
    else if (!temporary) {
      const note = creditNotes.find(n => n.creditNote.amount === amt);
      if (note && monthNumber(note.creditNote.month)) {
        const mon = monthNumber(note.creditNote.month);
        const hit = positives.filter(p => groupKey(p.desc) === groupKey(c.desc) && dateOf(p) && +dateOf(p).slice(5, 7) === mon);
        if (hit.length === 1) { target = hit[0].id; basis = `the email of ${fmt(note.date && note.date.value)} says "${note.creditNote.words}"`; }
      }
      if (!target) {
        const same = positives.filter(p => groupKey(p.desc) === groupKey(c.desc) && p.amount.value === amt && dateOf(p) <= dateOf(c));
        if (same.length === 1) { target = same[0].id; basis = 'it is the only charge of the same amount before it'; }
      }
    }
    const rec = { id: c.id, desc: c.desc, amount: amt, date: dateOf(c), src: c.src, statementId: c.statementId || null, temporary, target, basis };
    result.credits.push(rec);
    if (temporary) continue; // R25: a temporary credit is not a resolution
    if (target) (applied[target] ||= []).push(rec);
    else if (creditFor[c.id] === undefined) {
      result.questions.push({ id: `credit:${c.id}`, kind: 'credit', creditId: c.id,
        text: `Which charge is the ${dollars(amt)} credit of ${fmt(rec.date)} for?`,
        why: 'The amount you dispute for a charge is what remains after any credit for it.',
        options: [...positives.filter(p => groupKey(p.desc) === groupKey(c.desc)).map(p => [p.id, `${p.desc} ${dollars(p.amount.value)} on ${fmt(dateOf(p))}`]), ['', 'None of them']] });
    }
  }

  // ---- items
  const contest = choices.contest || {};
  const reasons = choices.reasons || {};
  const merchantOf = key => result.merchants.find(m => m.key === key);
  const interest = statementTx.filter(t => CARD_CHARGE.test(t.desc) && t.amount.value > 0);
  for (const t of all) {
    if (t.amount.value === null) continue;
    const key = groupKey(t.desc);
    const isMerchant = merchantSet.has(key) && t.amount.value > 0 && !NOT_MERCHANT.test(t.desc);
    if (!isMerchant) {
      if (t.amount.value > 0 && !NOT_MERCHANT.test(t.desc) && !CARD_CHARGE.test(t.desc)) result.otherCharges.push(t);
      continue;
    }
    const d = dateOf(t);
    const after = cancelDate.value && d ? d > cancelDate.value : null;
    const item = {
      id: t.id, kind: 'charge', merchant: merchantOf(key).name, merchantKey: key, desc: t.desc, ref: t.ref || null,
      trans: t.trans, post: t.post, shown: t.shown || null, amount: t.amount, src: t.src, source: t.source,
      statementId: t.statementId || null, afterCancel: after, flags: [], credits: applied[t.id] || [],
      betweenDates: between(d),
    };
    if (item.betweenDates) {
      const u = result.cancellation.until;
      item.flags.push(`This charge is after ${fmt(cancelDate.value)}, the date the page counts as the day you cancelled, but ${u.kind === 'effective' ? 'on or before' : 'before'} ${fmt(u.date)}, the date ${u.who} gives ("${u.words}"). Which date counts is not something this page decides, so it does not suggest disputing this charge or leaving it out. You choose.`);
    }
    const creditTotal = item.credits.reduce((s, c) => s + c.amount, 0);
    item.disputed = Math.max(0, Math.round((t.amount.value - creditTotal) * 100) / 100);
    if (PAY_SERVICE.test(t.desc) && choices.paidHow?.[t.id] === undefined) {
      result.questions.push({ id: `paid:${t.id}`, kind: 'paidHow', itemId: t.id, text: `The line "${t.desc}" names a payment service. How was it paid?`,
        why: 'A purchase paid in full by your card through a payment service is covered like any other card purchase. One paid from a wallet balance, or only partly by card, is not.',
        options: [['card-full', 'My card paid the full amount when I bought it'], ['other', 'From a wallet balance, or only partly by card']] });
    }
    if (choices.paidHow?.[t.id] === 'other') { item.window = { status: 'exit', why: ['Paid from a payment-service balance or only partly by card: the billing-error procedure for card purchases does not cover it. Ask the payment service how it handles disputes.'] }; }
    else if (t.source === 'bank' || result.method.value === 'debit') item.window = { status: 'exit', why: ['Debit card or bank account: handled by your bank under different rules (see the box at the top).'] };
    else item.window = windowForCharge(t);
    if (item.window.statement) item.statement = item.window.statement;
    if (item.disputed === 0 && item.credits.length) item.window = { ...item.window, status: 'credited', why: [...(item.window.why || []), `It was credited in full (${item.credits.map(c => `${dollars(c.amount)} on ${fmt(c.date)}`).join(', ')}), so there is nothing left to dispute.`] };
    // Contested contract terms: describe, never decide.
    if (result.contract) {
      const c = result.contract;
      if (/\bFEE\b/i.test(t.desc) || (c.fee && t.amount.value === c.fee)) item.flags.push(`${item.merchant} says this fee is owed under the agreement. You dispute that; the agreement and the law that applies to it decide, not this page.`);
      else if (c.finalDate && d && d <= c.finalDate) item.flags.push(`This is on or before ${fmt(c.finalDate)}, the last charge date ${item.merchant} gave. ${item.merchant} says it falls inside the notice period the agreement required.`);
      else if (c.finalDate && d && d > c.finalDate) item.flags.push(`This is after ${fmt(c.finalDate)}, the last charge date ${item.merchant} itself gave.`);
      item.contested = true;
    }
    // Carried balances never restart a window (R23).
    if (item.statement && !item.statement.synthetic) {
      const later = statements.filter(s => s.closing.value > item.statement.closing.value);
      if (later.length) item.carriedNote = `It first appeared on your ${item.statement.label}, and its 60 days count from that statement. Later statements that include it in the balance carried over from before do not restart its 60 days.`;
      item.related = interest.filter(i => stById[i.statementId] && stById[i.statementId].closing.value > item.statement.closing.value)
        .map(i => ({ desc: i.desc, amount: i.amount.value, date: dateOf(i), src: i.src }));
    } else item.related = [];
    // Inclusion: proposed when after the cancellation date and not possibly off-statement (R6/U3);
    // contested items, and items between the two cancellation dates, wait for the person.
    const proposed = item.window.recent ? false : (after === null ? true : after);
    const waits = item.contested || item.betweenDates;
    if (Object.prototype.hasOwnProperty.call(contest, t.id)) item.include = !!contest[t.id];
    else item.include = waits ? undefined : proposed;
    item.choice = Object.prototype.hasOwnProperty.call(contest, t.id) ? (contest[t.id] ? 'yes' : 'no') : null;
    item.proposed = waits ? undefined : proposed;
    item.reason = reasons[t.id] !== undefined ? reasons[t.id] : draftReason(item, result);
    item.reasonIsDraft = reasons[t.id] === undefined;
    if (after === false && !Object.prototype.hasOwnProperty.call(contest, t.id)) { result.beforeCancel.push(item); continue; }
    result.items.push(item);
  }

  // Failure to credit (R12): a promised refund that never posted is its own item.
  for (const x of evidencePapers.filter(p => p.data.refundPromise)) {
    const p = x.data.refundPromise;
    const id = `ftc:${x.data.paperId}`;
    const amount = fact(state, `${id}:amount`, p.amount, p.src);
    const promised = fact(state, `${id}:date`, p.date, p.src);
    const posted = merchantCredits.find(c => Math.abs(c.amount.value) === amount.value && dateOf(c) >= addDays(promised.value, -3));
    const merchant = x.data.org && x.data.org.name ? x.data.org.name : 'The business';
    if (posted) {
      result.timeline.push({ date: dateOf(posted), text: `The promised ${dollars(amount.value)} credit from ${merchant} appears on your statement.`, src: posted.src });
      continue;
    }
    const chosenSt = (choices.ftcStatement || {})[id];
    let st = chosenSt ? stById[chosenSt] : statements.find(s => s.closing.value && s.closing.value > promised.value);
    const item = { id, kind: 'ftc', merchant, desc: `Promised refund from ${merchant}, never credited`, amount, disputed: amount.value,
      promised, month: p.month, words: p.words, src: p.src, flags: [], credits: [], related: [], ref: null,
      statementChoice: { chosen: !!chosenSt, options: statements.filter(s => s.closing.value && s.closing.value > promised.value).map(s => [s.id, s.label]) } };
    if (st) {
      item.statement = st;
      item.window = statementWindow(st, today);
      item.window.why.unshift(`${merchant} said on ${fmt(promised.value)} that it had issued this refund. Not crediting it is its own billing error, separate from the charge it was meant to reverse. Its 60 days count from the statement on which the credit should have appeared. Which statement that is can be argued; this page uses the first statement closing after the promise (${st.label}), the earliest and so the safe choice.`);
    } else {
      const next = lastStatement ? addMonths(lastStatement.closing.value, 1) : null;
      item.window = { status: 'not-started', recheckAfter: next, why: [`${merchant} said on ${fmt(promised.value)} that it had issued a refund. No statement in your papers closes after that date, so the statement it should have appeared on is not here yet.`] };
    }
    if (result.method.value === 'debit') item.window = { status: 'exit', why: ['Debit card or bank account: handled by your bank under different rules.'] };
    item.include = Object.prototype.hasOwnProperty.call(contest, id) ? !!contest[id] : true;
    item.choice = Object.prototype.hasOwnProperty.call(contest, id) ? (contest[id] ? 'yes' : 'no') : null;
    item.proposed = true;
    item.reason = reasons[id] !== undefined ? reasons[id] : draftReason(item, result);
    item.reasonIsDraft = reasons[id] === undefined;
    result.items.push(item);
  }

  result.items.sort((a, b) => String(itemDate(a)).localeCompare(String(itemDate(b))) || a.id.localeCompare(b.id));
  if (result.items.some(i => i.contested && i.include === undefined)) {
    result.questions.push({ id: 'contest', kind: 'contest', text: 'Which of these charges do you want to dispute?',
      why: 'The business says the agreement allowed some of them. Whether it did is not something this page decides, so nothing goes in your notice until you choose.' });
  } else if (result.items.some(i => i.betweenDates && i.include === undefined)) {
    const u = result.cancellation.until;
    result.questions.push({ id: 'between', kind: 'contest', text: `Do you want to dispute the charges between ${fmt(cancelDate.value)} and ${fmt(u.date)}?`,
      why: `You cancelled on ${fmt(cancelDate.value)}, and ${u.who} gives ${fmt(u.date)} ("${u.words}"). This page counts from ${fmt(cancelDate.value)} but does not decide which date is right, so a charge between the two goes into nothing it drafts until you choose.` });
  }
  if (result.items.some(i => i.window.ask === 'closing') && !closingDay) {
    result.questions.push({ id: 'account:closingDay', kind: 'closingDay', text: 'What day of the month do your statements close?',
      why: 'It is printed on every statement (or the online statement list) as the closing date. With it, each charge can be matched to its statement and its 60 days counted from that statement instead of from the posting date.' });
  }

  // ---- channel (R13-R17)
  result.channel = channelOf(statements, state, result);

  // ---- exits (R2-R4)
  const m = result.method.value;
  if (m === 'debit') {
    const b = banks[0];
    result.exit = { kind: 'debit', title: 'This is a debit card, so the credit-card procedure does not apply',
      text: [
        'The steps on this page are for credit cards. A debit card or bank account is covered by a different rule, the Electronic Fund Transfer Act and its Regulation E. Your bank has its own process for errors under that rule. Whether a charge made after you cancelled counts as an error there depends on the facts, so ask your bank.',
        b && b.errorNotice ? `Your statement says: "${b.errorNotice.value}"` : 'Your bank statement or account agreement says how to tell your bank about an error.',
        'Contact your bank soon. Under that rule the bank must hear about an error no later than 60 days after it sent the first statement showing it. You can tell it by phone or in writing; it may ask you to confirm in writing within 10 business days. This page does not work out those dates and does not prepare a credit-card letter.',
        'Tell your bank that you cancelled and that the business no longer has your permission to charge your card, and ask how it can stop future charges. Tell the business in writing that you cancelled, and keep a copy.',
        'Your timeline and evidence list below are still yours to keep and use with your bank.',
      ], src: b && b.errorNotice ? b.errorNotice.src : null };
  } else if (m === 'business') {
    result.exit = { kind: 'business', title: 'Business or company cards may not have these protections',
      text: ['The billing-error rules this page uses cover personal credit cards. They may not apply to a card used for a business or issued to a company. Ask your card company how it handles disputes for this card.'] };
  } else if (m === 'prepaid') {
    result.exit = { kind: 'prepaid', title: 'Prepaid cards follow different rules',
      text: ['Prepaid accounts, overdraft lines and hybrid prepaid-credit cards fall under other rules depending on the transaction. This page does not work them out. Ask your card provider how to report an error.'] };
  }

  if (result.exit) result.questions = result.questions.filter(q => q.kind === 'method');

  // ---- timeline
  for (const c of cancelEvidence) {
    if (c.kind === 'own-words') continue;
    const who = c.kind === 'other' ? `Your record (${paperName[c.paperId]})` : (c.role === 'request' ? 'You asked to cancel' : `${c.by} wrote`);
    result.timeline.push({ date: c.date, text: `${who}: "${c.quote || ''}"${c.effective ? ` (effective ${fmt(c.effective.value)})` : ''}${c.ends ? ` (${c.ends.words})` : ''}`, src: c.src });
  }
  for (const x of evidencePapers) {
    const d = x.data;
    if (d.merchantReply) result.timeline.push({ date: d.date && d.date.value, text: `${d.from && d.from.name} replied: "${d.merchantReply.words}"`, src: d.merchantReply.src });
    if (d.refundPromise) result.timeline.push({ date: d.refundPromise.date, text: `${d.from && d.from.name} wrote that it "${d.refundPromise.words}"`, src: d.refundPromise.src });
    if (d.creditNote) result.timeline.push({ date: d.date && d.date.value, text: `${d.from && d.from.name} wrote that it "${d.creditNote.words}"`, src: d.creditNote.src });
    if (d.contractClaims && !d.cancellation) result.timeline.push({ date: d.date && d.date.value, text: `${d.from && d.from.name} wrote about the agreement`, src: d.contractClaims[0].src });
  }
  for (const st of statements) {
    result.timeline.push({ date: st.closing.value, text: `Statement closes (${paperName[st.paperId]})`, src: st.closing.src });
    if (st.transmitted.value) result.timeline.push({ date: st.transmitted.value, text: 'Statement sent ("statement is ready" email)', src: st.transmitted.src });
  }
  for (const it of [...result.items, ...result.beforeCancel]) {
    if (it.kind !== 'charge') continue;
    result.timeline.push({ date: itemDate(it), text: `${it.desc} ${dollars(it.amount.value)}${it.window.status === 'pending' ? ' (pending)' : ''}`, src: it.src, itemId: it.id });
  }
  for (const c of result.credits) result.timeline.push({ date: c.date, text: `Credit ${c.desc} ${dollars(-c.amount)}${c.temporary ? ' (temporary credit, not a final result)' : ''}`, src: c.src });
  result.timeline = result.timeline.filter(e => e.date).sort((a, b) => a.date.localeCompare(b.date));

  // ---- conflicts the page will not resolve silently
  for (const it of result.items) {
    if (it.kind === 'charge' && it.trans.value && it.post.value && it.post.value < it.trans.value) {
      result.conflicts.push({ text: `${it.desc}: posted ${fmt(it.post.value)} before the transaction date ${fmt(it.trans.value)}. One of the two dates is wrong; correct it.`, itemId: it.id });
    }
  }
  if (cancelDate.value && cancelDate.value > today) result.conflicts.push({ text: `The cancellation date ${fmt(cancelDate.value)} is in the future. Correct it.` });
  for (const st of statements) {
    if (st.transmitted.value && st.closing.value && st.transmitted.value < st.closing.value) {
      result.conflicts.push({ text: `The ${st.label} is said to have been sent on ${fmt(st.transmitted.value)}, before it closed. A statement cannot be sent before it closes; check the date.` });
    }
  }
  const names = new Set(cardStatements.map(s => s.cardholder && compact(s.cardholder.value)).filter(Boolean));
  if (names.size > 1) result.conflicts.push({ text: 'Your statements show different cardholder names. Check that they are all for the same card.' });

  return result;
}

export function itemDate(it) {
  if (it.kind === 'ftc') return it.promised.value;
  return it.trans.value || it.post.value || it.shown;
}

function draftReason(item, result) {
  const c = result.cancellation;
  const when = c.date.value ? fmt(c.date.value) : '[the date you cancelled]';
  if (item.kind === 'ftc') {
    return `${item.merchant} told me by email on ${fmt(item.promised.value)} that it had issued a refund of ${dollars(item.amount.value)}${item.month ? ` for my ${item.month} charge` : ''}. That credit has not appeared on my statements.`;
  }
  if (item.contested) {
    return `I cancelled on ${when}. [Write in your own words why you dispute this charge.]`;
  }
  if (item.betweenDates) {
    const u = c.until;
    return `I cancelled ${item.merchant} on ${when}. [${u.by === 'you' ? 'My own message' : u.by === 'record' || !u.by ? 'My record' : `${u.by}'s message`} gives ${fmt(u.date)} ("${u.words}"). Write in your own words why you dispute this charge.]`;
  }
  const conf = c.confirmation;
  let s = `I cancelled ${item.merchant} on ${when}.`;
  if (conf && conf.date) {
    s += ` ${conf.by} confirmed the cancellation by email on ${fmt(conf.date)}`;
    if (conf.effective && conf.effective.value !== conf.date) s += `, effective ${fmt(conf.effective.value)}`;
    else if (conf.ends) s += `, with access ending ${fmt(conf.ends.value)}`;
    s += conf.promise && conf.promise.sentence ? `. It wrote: "${conf.promise.sentence.replace(/^.*?(?=[A-Z][^.]*$)/, '')}"` : '.';
  } else {
    const rec = c.evidence.find(e => e.kind === 'other' && e.promise);
    if (rec) s = `I turned off renewal for ${item.merchant} by ${fmt(rec.date)}; its account page said "${rec.promise.words}".`;
  }
  s += ' This charge was made after I cancelled.';
  if (item.credits && item.credits.length) {
    s += ` ${item.merchant} credited ${item.credits.map(x => `${dollars(x.amount)} on ${fmt(x.date)}`).join(' and ')} toward it. I am disputing the remaining ${dollars(item.disputed)}.`;
  }
  return s;
}

function channelOf(statements, state, result) {
  // Latest statement with billing-rights text or a billing-error address governs.
  const withRights = [...statements].reverse().find(s => s.raw.rights && s.raw.rights.present);
  const withAddress = [...statements].reverse().find(s => s.raw.billingAddress);
  const addrSrc = (withRights && withRights.raw.billingAddress) ? withRights : withAddress;
  const address = fact(state, 'channel:address', addrSrc ? addrSrc.raw.billingAddress.value : null, addrSrc ? addrSrc.raw.billingAddress.src : null);
  const rights = withRights ? withRights.raw.rights : null;
  const elecAnswer = fact(state, 'channel:electronic', rights ? (rights.electronic ? 'yes' : 'no') : null, rights && rights.line).value;
  const paymentAddr = statements.map(s => s.raw.paymentAddress).find(Boolean);
  const ch = { address, rights, paymentAddress: paymentAddr || null, notes: [] };
  if (elecAnswer === 'yes') {
    ch.kind = 'electronic';
    ch.means = (rights && (rights.electronicDetail || rights.electronicMeans)) || 'the electronic means your statement names';
    ch.notes.push(`The "Your Billing Rights" section of your statement (its billing-rights text) says you may tell your card company electronically, using ${rights && rights.electronicMeans ? rights.electronicMeans : 'the means it names'}. A message sent that way counts as a written notice for this account.`);
    if (rights && rights.electronicDetail) ch.notes.push(`How, in its words: ${rights.electronicDetail}`);
    if (address.value) ch.notes.push('Mail to the billing-error address also counts. Either is your choice.');
    ch.notes.push('A general "report a problem" or "dispute" button in the app is not necessarily that channel. Use the one your statement names.');
  } else if (rights) {
    ch.kind = 'written';
    ch.notes.push('The "Your Billing Rights" section of your statement (usually on the back; its billing-rights text) asks for these notices in writing, to the address below.');
    if (rights.disclaimsElectronic) ch.notes.push('It also says that if you call or tell it electronically, your card company is not required to investigate. So a dispute by app or phone is not this notice. You can still use them as well; that is your choice. The written notice is prepared either way.');
  } else if (address.value) {
    ch.kind = 'written-unverified';
    ch.notes.push('Your papers include the billing-inquiries address but not the "Your Billing Rights" section of the statement (its billing-rights text), so it is not known whether this card company accepts a notice sent electronically. A written notice to that address is prepared.');
    ch.notes.push('That section (usually on the back of the statement or on a later page) would say whether an electronic route counts. An app "Dispute this charge" button is not assumed to count. You may use it as well.');
  } else {
    ch.kind = 'unknown';
    ch.notes.push('Your papers do not show where this card company wants billing-error notices sent. That address is printed with your statement (often under "Your Billing Rights" or "write to us at"). It may differ from the payment address. Get a statement or ask the card company for its billing-rights text, then enter the address here.');
    if (result.items.length) result.questions.push({ id: 'channel:address', kind: 'address', text: 'What address does your statement give for billing errors?',
      why: 'The notice has to arrive at that address. This page does not look it up anywhere else.' });
  }
  if (paymentAddr && (ch.kind === 'written' || ch.kind === 'written-unverified')) ch.notes.push(`Not the payment address (${paymentAddr.value.replace(/\n/g, ', ')}): payments and billing errors go to different places.`);
  if (address.corrected) ch.notes.push('You entered or corrected this address.');
  return ch;
}

// --------------------------------------------------------- save and reopen

export function snapshot(result) {
  const items = {};
  for (const it of result.items) {
    items[it.id] = { label: `${it.desc} ${dollars(it.disputed)} (${fmt(itemDate(it))})`, status: it.window.status,
      arriveBy: it.window.arriveBy || null, daysLeft: it.window.daysLeft ?? null, include: it.include };
  }
  return { asOf: result.today, items };
}

export function whatChanged(prev, result) {
  if (!prev || !prev.asOf) return null;
  const days = diffDays(result.today, prev.asOf);
  const lines = [];
  for (const it of result.items) {
    const was = prev.items[it.id];
    const label = `${it.desc} ${dollars(it.disputed)} (${fmt(itemDate(it))})`;
    const now = it.window;
    if (!was) { lines.push(`${label}: new since you saved.`); continue; }
    if (was.status !== now.status) {
      lines.push(`${label}: was "${STATUS_LABEL[was.status]}", now "${STATUS_LABEL[now.status]}".`);
    } else if (isOpenStatus(now.status) && was.daysLeft !== null && now.daysLeft !== null) {
      lines.push(`${label}: ${now.daysLeft} day${now.daysLeft === 1 ? '' : 's'} left (was ${was.daysLeft}).`);
    }
    if (now.status === 'not-started' && now.recheckAfter && now.recheckAfter <= result.today) {
      lines.push(`${label}: the statement closing around ${fmt(now.recheckAfter)} should be out by now. Add it to start this charge's window.`);
    }
  }
  for (const id of Object.keys(prev.items)) {
    if (!result.items.some(i => i.id === id)) lines.push(`${prev.items[id].label}: no longer in the case (a paper or choice changed).`);
  }
  return { savedOn: prev.asOf, days, lines };
}

export function serialize(state, result) {
  return JSON.stringify({ ...state, format: FORMAT, version: VERSION, savedAt: result.today, snapshot: snapshot(result) }, null, 2);
}

export function deserialize(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('This file is not a saved case from this page (it is not readable as one).'); }
  if (!data || data.format !== FORMAT) throw new Error('This file is not a saved case from this page.');
  if (data.version > VERSION) throw new Error('This case file was saved by a newer version of this page.');
  return { ...emptyState(), ...data, papers: Array.isArray(data.papers) ? data.papers : [], corrections: data.corrections || {}, choices: data.choices || {} };
}

export { money };
