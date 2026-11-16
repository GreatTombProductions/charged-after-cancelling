// What the person takes away. Every text here is computed from analyze(),
// so a corrected fact changes each output that depends on it.
// Wording limits (RECEIVER_CONTRACT.md section 6): no sentence says a notice
// was sent, received, valid or won; nothing says money will come back; no
// instruction to pay or withhold; no firm deadline from an inferred start.

import { fmt, addDays } from './dates.mjs';
import { dollars, itemDate, isOpenStatus, isClosedStatus, STATUS_LABEL } from './case.mjs';
import { KIND_LABELS } from './papers.mjs';

const NOT_SENDABLE = new Set(['closed', 'closed-bound', 'not-started', 'pending', 'credited', 'exit']);

export function sendable(result) {
  return result.items.filter(i => i.include === true && !NOT_SENDABLE.has(i.window.status));
}

export function closedKept(result) {
  return result.items.filter(i => isClosedStatus(i.window.status));
}

// The words after the status label. The label says what state the item is in;
// this says the date, so the two never repeat each other (cold walk 5).
export function deadlineText(w) {
  if (!w) return 'no date is known for it';
  switch (w.status) {
    case 'open': return `must arrive by ${fmt(w.arriveBy)} (${daysWord(w.daysLeft)})`;
    case 'open-at-least': return `at least until ${fmt(w.earliest)}${w.latest ? `, possibly until ${fmt(w.latest)}` : ''}. The true deadline may be later (${daysWord(w.daysLeft)} to the earlier date)`;
    case 'may-be-closed': return `it had at least until ${fmt(w.earliest)}, which has passed${w.latest ? `; possibly until ${fmt(w.latest)}` : ''}`;
    case 'closed': return `they ended on ${fmt(w.arriveBy)}`;
    case 'closed-bound': return `even the latest of those dates, ${fmt(w.latest)}, has passed`;
    case 'not-started': return w.recheckAfter ? `its 60 days start once a statement shows it. Check your statement closing around ${fmt(w.recheckAfter)}` : 'its 60 days start once a statement shows it';
    case 'pending': return 'its 60 days start once a statement shows it';
    case 'credited': return 'nothing left to dispute';
    case 'exit': return 'see the box at the top';
    default: return w.earliest ? `earliest possible deadline ${fmt(w.earliest)}${w.recent ? '; it may not be on a statement yet' : ''}` : 'see how this date was worked out';
  }
}

// What "60 days have passed" means, said where the status is (cold walk 6).
export function closedNote(it, result) {
  if (!isClosedStatus(it.window.status)) return null;
  // The status line already gives the date; this says what passed and what is left.
  const rule = 'Within its 60 days, a written notice brings the protections of the federal rules for credit-card billing errors (12 CFR 1026.13): your card company has to look into the charge. A notice sent now does not.';
  if (it.include === false) return rule;
  const issuer = result.account.issuer || 'your card company';
  const merchant = result.merchants.map(m => m.name).join(' / ') || 'the business';
  return `${rule} You can still ask ${issuer} and ${merchant} about it: the page drafts the words under "Older charges".`;
}

// Arrival, not sending (R7, cold walk 8). Never a send-by date.
export function arrivalNote(result) {
  return result.channel.kind === 'electronic'
    ? 'Sent electronically, it arrives the same day. By mail, the date is when it must reach the card company, not the day you post it, and the post takes time.'
    : 'That is the date it must reach the card company, not the day you post it. The post takes time, so allow for it.';
}

export const NO_NOTICE = 'No letter is ready yet: no charge is both one you chose to dispute and still within its 60 days (or possibly within them).';

// "today", a date, or "when you can" for a to-do entry.
export function todoWhen(t, today) {
  if (!t.date) return 'When you can';
  if (t.after) return `After ${fmt(t.date)}`;
  return t.date === today ? `Now (${fmt(t.date)})` : `By ${fmt(t.date)}`;
}

export function daysWord(n) {
  if (n === undefined || n === null) return '';
  if (n === 0) return 'today is the last day';
  return `${n} day${n === 1 ? '' : 's'} left`;
}

// --------------------------------------------------------- evidence index

export function evidenceIndex(result) {
  const out = [];
  const includedIds = new Set(sendable(result).map(i => i.id));
  const stOf = id => result.statements.find(s => s.paperId === id);
  for (const { paper, data } of result.parsed) {
    if (data.kind === 'own-note') continue;
    const e = { paperId: paper.id, name: paper.name || paper.id, kind: KIND_LABELS[data.kind], date: null, what: '', supports: [], enclose: false };
    if (data.kind === 'card-statement') {
      const st = stOf(paper.id);
      e.date = st && st.closing.value;
      e.what = `Credit card statement closing ${fmt(e.date)}${data.ending ? `, account ending ${data.ending.value}` : ''}`;
      e.supports = result.items.filter(i => i.statement && i.statement.id === `st:${paper.id}`).map(i => i.id);
      e.enclose = e.supports.some(id => includedIds.has(id));
    } else if (data.kind === 'email') {
      e.date = data.date && data.date.value;
      const who = data.byPerson ? 'Your email' : `Email from ${data.from ? data.from.name : 'unknown sender'}`;
      e.what = `${who}, ${fmt(e.date)}: "${data.subject}"`;
      if (data.statementReady) {
        e.what += ' (shows when a statement was sent)';
        e.supports = result.items.filter(i => i.statement && i.statement.transmitted && i.statement.transmitted.src && i.statement.transmitted.src.paper === paper.id).map(i => i.id);
        e.keep = true;
      } else if (data.cancellation || data.merchantReply || data.contractClaims) {
        e.supports = result.items.filter(i => i.kind === 'charge').map(i => i.id);
        e.enclose = sendable(result).some(i => i.kind === 'charge');
      }
      if (data.refundPromise) { e.supports = result.items.filter(i => i.id === `ftc:${paper.id}`).map(i => i.id); e.enclose = includedIds.has(`ftc:${paper.id}`); }
      if (data.creditNote) { e.supports = result.items.filter(i => i.credits.length).map(i => i.id); e.enclose = e.supports.some(id => includedIds.has(id)); }
    } else if (data.kind === 'bank-statement') {
      e.date = data.period && data.period.to;
      e.what = `Bank statement${data.period ? ` ${fmt(data.period.from)} to ${fmt(data.period.to)}` : ''}`;
      e.supports = result.items.map(i => i.id);
    } else if (data.kind === 'app-list') {
      e.date = data.copied && data.copied.value;
      e.what = `List copied from your app or website${e.date ? ` on ${fmt(e.date)}` : ''}`;
    } else {
      e.date = data.date && data.date.value;
      e.what = data.cancellation ? `${paper.name}: "${data.cancellation.quote}"` : paper.name;
      if (data.cancellation) { e.supports = result.items.filter(i => i.kind === 'charge').map(i => i.id); e.enclose = sendable(result).some(i => i.kind === 'charge'); }
    }
    out.push(e);
  }
  out.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || a.name.localeCompare(b.name));
  out.forEach((e, k) => { e.n = `E${k + 1}`; });
  return out;
}

// ---------------------------------------------------------------- notices

function accountLine(result, choices) {
  const ending = result.account.ending;
  if ((choices.accountIdent || 'ending') === 'blank') return 'Account number: ______________________ (full number, written in by hand)';
  return ending ? `Account ending in ${ending}` : 'Account number: ______________________';
}

function itemBlock(it, k) {
  const lines = [];
  if (it.kind === 'ftc') {
    lines.push(`${k}. Credit not given: refund of ${dollars(it.amount.value)} from ${it.merchant}`);
    lines.push(`   ${it.merchant} wrote on ${fmt(it.promised.value)}: "${it.words}"`);
    if (it.statement) lines.push(`   The credit should have appeared on my statement closing ${fmt(it.statement.closing.value)}; it is not on that statement or later ones I have.`);
    lines.push(`   Amount: ${dollars(it.disputed)}`);
  } else {
    lines.push(`${k}. ${it.desc}`);
    const dates = [];
    if (it.trans.value) dates.push(`Transaction date: ${fmt(it.trans.value)}`);
    if (it.post.value) dates.push(`Posting date: ${fmt(it.post.value)}`);
    if (!dates.length && it.shown) dates.push(`Date: ${fmt(it.shown)}`);
    lines.push(`   ${dates.join('   ')}`);
    if (it.ref) lines.push(`   Reference number: ${it.ref}`);
    if (it.disputed !== it.amount.value) {
      lines.push(`   Charged: ${dollars(it.amount.value)}. Already credited: ${it.credits.map(c => `${dollars(c.amount)} on ${fmt(c.date)}`).join(', ')}. Amount in dispute: ${dollars(it.disputed)}`);
    } else lines.push(`   Amount: ${dollars(it.disputed)}`);
    if (it.statement) lines.push(`   First appeared on my statement closing ${fmt(it.statement.closing.value)}`);
  }
  lines.push(`   Why I believe this is an error: ${it.reason}`);
  if (it.related && it.related.length) {
    lines.push(`   Related charges: ${it.related.map(r => `${r.desc.toLowerCase()} ${dollars(r.amount)} on ${fmt(r.date)}`).join('; ')}. These may include finance charges on this amount.`);
  }
  return lines.join('\n');
}

function enclosureLines(result, items) {
  const ids = new Set(items.map(i => i.id));
  return evidenceIndex(result).filter(e => e.enclose && e.supports.some(id => ids.has(id))).map(e => `   - ${e.n}: ${e.what}`);
}

function deadlineFor(items) {
  const open = items.filter(i => isOpenStatus(i.window.status));
  if (!open.length) return null;
  const first = open.reduce((a, b) => (a.window.arriveBy <= b.window.arriveBy ? a : b));
  return { date: first.window.arriveBy, firm: first.window.status === 'open', item: first, daysLeft: first.window.daysLeft };
}

function addressBlock(result) {
  const a = result.channel.address.value;
  return a ? a.split('\n') : ['[Billing-error address from your statement: not found in your papers]'];
}

export function notices(result, choices = {}) {
  const items = sendable(result);
  if (!items.length || result.exit) return [];
  const groups = (choices.grouping || 'one') === 'split' ? items.map(i => [i]) : [items];
  const closed = choices.mentionClosed ? result.items.filter(i => i.include === true && isClosedStatus(i.window.status)) : [];
  return groups.map((group, g) => {
    const d = deadlineFor(group);
    const name = result.account.name.value || '[Your name]';
    const product = [result.account.issuer, result.account.product && !String(result.account.product).includes(result.account.issuer || '\u0000') ? result.account.product : null].filter(Boolean).join(' ') || 'credit card';
    const body = [];
    body.push(`I believe the following ${group.length === 1 ? 'item is a billing error' : `${group.length} items are billing errors`} on my credit card account.`);
    body.push('');
    body.push(`Name on the account: ${name}`);
    body.push(accountLine(result, choices));
    body.push('');
    group.forEach((it, k) => { body.push(itemBlock(it, k + 1)); body.push(''); });
    if (closed.length && g === groups.length - 1) {
      body.push('I understand the following earlier charges are outside the 60-day period for billing-error notices. I ask you to review them as well:');
      closed.forEach(it => body.push(`   - ${it.desc}, ${fmt(itemDate(it))}, ${dollars(it.disputed)}`));
      body.push('');
    }
    body.push('Please correct these items and any related finance or other charges, and tell me the result in writing.');
    const enc = enclosureLines(result, group);
    if (enc.length && result.channel.kind !== 'electronic') { body.push(''); body.push('Enclosed (copies, not originals):'); body.push(...enc); }
    if (enc.length && result.channel.kind === 'electronic') { body.push(''); body.push('I can provide copies of these records:'); body.push(...enc); }
    const letter = [
      'Date: ____________________',
      '',
      name,
      '[Your address]',
      '',
      ...addressBlock(result),
      '',
      `Re: Billing error notice, ${product}, ${accountLine(result, choices).replace(/^Account /, 'account ')}`,
      '',
      ...body,
      '',
      'Sincerely,',
      '',
      '______________________',
      name,
    ].join('\n');
    const message = [`Billing error notice: ${accountLine(result, choices).replace(/^Account /, 'account ')}`, '', ...body, '', name].join('\n');
    return {
      title: groups.length > 1 ? `Notice ${g + 1} of ${groups.length}: ${group[0].desc}` : 'Your notice',
      items: group.map(i => i.id), deadline: d, letter, message,
    };
  });
}

export function groupingAdvice(result) {
  const items = sendable(result).filter(i => isOpenStatus(i.window.status));
  if (items.length < 2) return null;
  const dates = [...new Set(items.map(i => i.window.arriveBy))].sort();
  if (dates.length < 2) return null;
  const urgent = items.filter(i => i.window.arriveBy === dates[0]);
  return `Sending everything together means the whole notice has to arrive by ${fmt(dates[0])}, the earliest date, because of ${urgent.map(i => `${i.desc} (${fmt(itemDate(i))})`).join(' and ')}. The others have until ${fmt(dates[dates.length - 1])} or later. You can send the urgent item on its own so it is not held back, and the rest are not rushed.`;
}

export function urgency(result) {
  const out = [];
  for (const it of sendable(result)) {
    const w = it.window;
    if (!isOpenStatus(w.status) || w.daysLeft > 10) continue;
    if (result.channel.kind === 'electronic') {
      out.push({ itemId: it.id, text: `${it.desc} (${fmt(itemDate(it))}): ${daysWord(w.daysLeft)}. You can send the electronic notice today.` });
    } else {
      out.push({ itemId: it.id, text: `${it.desc} (${fmt(itemDate(it))}): ${daysWord(w.daysLeft)}, and the date is when it must arrive, not when you send it. Ordinary mail sent today may not arrive in time. How you deliver it, and whether you pay for a way that arrives fast and shows when it arrived, is your choice.` });
    }
  }
  return out;
}

// ------------------------------------------------------ outside the window

// A charge the person said "No" to is in no request and no count; it stays in
// their record as their choice (cold walk 2). One they have not decided on is
// listed but not asked about until they choose.
export function outsideWindow(result) {
  const past = result.items.filter(i => i.include !== false);
  const items = past.filter(i => isClosedStatus(i.window.status));
  const maybe = past.filter(i => i.window.status === 'may-be-closed');
  if (!items.length && !maybe.length) return null;
  const ask = [...items, ...maybe].filter(i => i.include === true);
  const undecided = [...items, ...maybe].filter(i => i.include === undefined);
  const issuer = result.account.issuer || 'your card company';
  const merchant = result.merchants.map(m => m.name).join(' / ') || 'the business';
  const lines = [
    `These charges are past their 60 days${maybe.length ? ', or may be' : ''}. Within those days a written notice brings the protections of the federal rules for credit-card billing errors (12 CFR 1026.13); a notice now does not. They are kept here, and you can still ask about them.`,
    `You can ask ${issuer} through its own dispute process. Some card companies say they may be able to help even after 60 days; that is up to them. You can also ask ${merchant} directly, with your cancellation record.`,
  ];
  if (undecided.length) lines.push(`You have not chosen whether to dispute ${undecided.length === 1 ? 'one of them' : `${undecided.length} of them`}; ${undecided.length === 1 ? 'it is' : 'they are'} left out of the text below until you do (under "Your charges").`);
  const request = ask.length ? [
    `I am asking you to review ${ask.length === 1 ? 'this charge' : 'these charges'} from ${merchant}, made after I cancelled${result.cancellation.date.value ? ` on ${fmt(result.cancellation.date.value)}` : ''}. I understand ${ask.length === 1 ? 'it' : 'they'} may be outside the 60-day period for billing-error notices.`,
    '',
    `Name on the account: ${result.account.name.value || '[Your name]'}`,
    result.account.ending ? `Account ending in ${result.account.ending}` : 'Account number: ____________',
    '',
    ...ask.map(i => `- ${i.desc}, ${fmt(itemDate(i))}, ${dollars(i.disputed)}${i.statement ? `, first on my statement closing ${fmt(i.statement.closing.value)}` : ''}`),
    '',
    'I have my cancellation record and can provide copies.',
  ].join('\n') : null;
  return { items, maybe, ask, undecided, lines, request };
}

// --------------------------------------------------------- future charges

export function stopNote(result) {
  const merchant = result.merchants.map(m => m.name).join(' / ') || 'the business';
  const issuer = result.account.issuer || 'your card company';
  if (result.exit && result.exit.kind === 'debit') {
    return [`Ask your bank how it can stop future charges from ${merchant}, and tell ${merchant} in writing that you cancelled. Keep a copy.`];
  }
  return [
    `Disputing a charge does not cancel your agreement with ${merchant} or stop it from charging again.`,
    `Tell ${merchant} in writing that you cancelled${result.cancellation.date.value ? ` on ${fmt(result.cancellation.date.value)}` : ''}, and keep a copy of what you send.`,
    `Ask ${issuer} what it can do about future charges from ${merchant}. This page found no published way to block one business on a credit card, so ask.`,
    'Each new charge is its own item, with its own statement and its own 60 days. Add new statements here as they arrive.',
  ];
}

// --------------------------------------------------------------- to-do list

// Actions first, in the order of their dates; things to keep in mind apart
// (cold walk 7). Each entry: { kind: 'do' | 'keep', date (null = when you
// can), text, urgent }. Undated actions follow the dated ones.
export function todo(result, choices = {}) {
  const t = result.today;
  const out = [];
  const add = (date, text, urgent = false, after = false) => out.push({ kind: 'do', date, text, urgent, after });
  const keep = text => out.push({ kind: 'keep', date: null, text, urgent: false });
  const issuer = result.account.issuer || 'your card company';
  const merchant = result.merchants.map(m => m.name).join(' / ');
  if (result.exit) {
    add(t, result.exit.kind === 'debit' ? 'Contact your bank soon (the notice on your bank statement says how). Tell it you cancelled, ask whether it treats these charges as errors, and ask how to stop future charges.' : 'Ask your card company how it handles disputes for this card.', true);
    add(null, 'Keep your timeline and evidence list (save your work as a file, or download the packet).');
    return out;
  }
  for (const q of result.questions) add(t, `Answer the question at the top: ${q.text}`, true);
  for (const c of result.conflicts) add(t, `Check: ${c.text}`, true);
  for (const m of result.missingStatements || []) {
    const period = m.from ? ` (covering ${fmt(m.from)} to ${fmt(m.to)})` : '';
    const who = merchant || 'the business you cancelled';
    const which = m.sent ? `your statement sent on ${fmt(m.sent)}${period}` : `your statement${period}`;
    if (isOpenStatus(m.window.status)) {
      const by = m.window.status === 'open' ? `has to arrive by ${fmt(m.window.arriveBy)}` : `has at least until ${fmt(m.window.earliest)} to arrive`;
      add(m.window.arriveBy, `Find ${which}. If it shows a charge from ${who}, add it here: a notice about that charge ${by} (${daysWord(m.window.daysLeft)}).`, m.soon);
    } else add(null, `If you have ${which}, add it, so any charge on it from ${who} is in your record. ${m.window.status === 'closed' ? 'Its 60 days have passed, so such a charge can only be asked about (see "Older charges").' : 'It may already be too late for a notice about a charge on it.'}`);
  }
  for (const m of result.missing) if (!m.statement) (m.note ? keep(m.text) : add(null, m.text));
  const ns = notices(result, choices);
  const electronic = result.channel.kind === 'electronic';
  for (const n of ns) {
    const drafts = n.items.map(id => result.items.find(i => i.id === id)).some(i => i.reasonIsDraft || /\[Write in your own words/.test(i.reason));
    const steps = [];
    if (drafts) steps.push('read the reason for each charge and put it in your own words');
    if (!electronic) steps.push('fill in your address and the date, and sign it');
    const how = electronic ? 'send it through the electronic channel your statement names (or by mail to the billing-error address)' : 'send it to the billing-error address';
    const lead = `${n.title}: ${steps.length ? `${steps.join('; ')}; then ` : ''}${how}`;
    if (n.deadline) {
      const post = electronic ? ' By mail, allow for the post.' : ` The post takes time: ${fmt(n.deadline.date)} is when it must arrive, not when you send it.`;
      add(n.deadline.date, n.deadline.firm
        ? `${lead} so that it arrives by ${fmt(n.deadline.date)}.${post} Keep a copy of exactly what you send, and any proof of when it arrived. Whether and how to send it is your choice.`
        : `${lead}, aiming for it to arrive by ${fmt(n.deadline.date)}. The true deadline may be later but is not known from your papers.${post} Keep a copy of exactly what you send, and any proof of when it arrived.`, n.deadline.daysLeft <= 10);
    } else {
      add(null, `${lead}. Its deadline is not known from your papers (see each charge), so sooner is safer. Keep a copy of exactly what you send.`);
    }
  }
  for (const it of result.items) {
    if (it.window.status === 'not-started') add(it.window.recheckAfter || null, `Check ${it.window.recheckAfter ? `your statement closing around ${fmt(it.window.recheckAfter)}` : 'your next statement'} for ${it.desc} (${fmt(itemDate(it))}), and add it here. That starts its 60 days.`, false, true);
    if (it.window.status === 'pending') add(null, `${it.desc} ${dollars(it.amount.value)} is pending. Once it appears on a statement, add that statement here.`);
  }
  if (merchant) add(null, `Tell ${merchant} in writing that you cancelled, and keep a copy (see "Future charges").`);
  const ow = outsideWindow(result);
  if (ow && ow.ask.length) add(null, `If you want to, ask ${issuer} or ${merchant || 'the business'} about ${ow.ask.length} older charge${ow.ask.length > 1 ? 's' : ''} past ${ow.ask.length > 1 ? 'their' : 'its'} 60 days (see "Older charges"). The protections of a notice in time do not come with that request.`);
  keep(`Nothing happens by itself. This page sends nothing and will not remind you: watch your statements and any reply from ${issuer}.`);
  const rank = e => (e.kind === 'keep' ? 2 : e.date ? 0 : 1);
  return out.map((e, k) => ({ e, k })).sort((a, b) => rank(a.e) - rank(b.e) || String(a.e.date || '').localeCompare(String(b.e.date || '')) || (b.e.urgent - a.e.urgent) || a.k - b.k).map(x => x.e);
}

// -------------------------------------------------------------- the packet

export function chargeRows(result) {
  return result.items.map(it => ({
    id: it.id,
    what: it.kind === 'ftc' ? it.desc : `${it.desc}`,
    date: itemDate(it),
    amount: it.amount.value,
    disputed: it.disputed,
    statement: it.statement ? it.statement.label : null,
    status: it.window.status,
    statusLabel: STATUS_LABEL[it.window.status],
    deadline: deadlineText(it.window),
    why: [...(it.window.why || []), ...(it.carriedNote ? [it.carriedNote] : []), ...it.flags],
    include: it.include,
    choice: it.choice || null,
    closedNote: closedNote(it, result),
  }));
}

export function packetText(result, choices = {}) {
  const L = [];
  const rule = '='.repeat(72);
  L.push('CHARGED AFTER CANCELLING: PREPARATION PACKET');
  L.push(`Prepared on ${fmt(result.today)} from your own papers. This page sends nothing and contacts no one.`);
  L.push('Every 60 days here is counted from that day. Open your saved work on a later day to count them again.');
  L.push('');
  if (result.exit) {
    L.push(rule); L.push(result.exit.title.toUpperCase()); L.push(rule);
    L.push(...result.exit.text); L.push('');
  }
  for (const m of result.exit ? [] : (result.missingStatements || []).filter(x => isOpenStatus(x.window.status))) L.push(`${m.soon ? '!! ' : ''}${m.text}`);
  if (!result.exit && (result.missingStatements || []).some(x => isOpenStatus(x.window.status))) L.push('');
  L.push(rule); L.push('YOUR CHARGES'); L.push(rule);
  for (const r of chargeRows(result)) {
    L.push(`- ${r.what}, ${fmt(r.date)}, ${dollars(r.amount)}${r.disputed !== r.amount ? ` (in dispute: ${dollars(r.disputed)})` : ''}`);
    L.push(`  ${r.statusLabel}: ${r.deadline}`);
    if (r.statement) L.push(`  First shown on your ${r.statement}`);
    if (r.include === undefined) L.push('  You have not chosen whether to dispute this one. It is in nothing the page drafts until you do.');
    else if (r.include === false) L.push(r.choice === 'no' ? '  You chose not to dispute this charge. It is left out of every letter and request the page drafts, and kept here in your record.'
      : '  Not suggested for your notice: it may not be on a statement yet (see below). You can choose to include it.');
    if (r.closedNote) L.push(`  ${r.closedNote}`);
    for (const w of r.why) L.push(`  * ${w}`);
  }
  if (result.beforeCancel.length) {
    L.push(''); L.push('Charges from the same business before your cancellation date (not proposed):');
    for (const i of result.beforeCancel) L.push(`- ${i.desc}, ${fmt(itemDate(i))}, ${dollars(i.amount.value)}`);
  }
  L.push('');
  if (!result.exit) {
    L.push(rule); L.push('WHERE THE NOTICE GOES'); L.push(rule);
    L.push(...result.channel.notes);
    if (result.channel.address.value) { L.push(''); L.push(...result.channel.address.value.split('\n').map(s => `  ${s}`)); }
    L.push('');
    for (const u of urgency(result)) L.push(`! ${u.text}`);
    const adv = groupingAdvice(result);
    if (adv && (choices.grouping || 'one') === 'one') L.push(`Note: ${adv}`);
    for (const n of notices(result, choices)) {
      L.push(''); L.push(rule); L.push(n.title.toUpperCase()); L.push(rule);
      if (n.deadline) L.push(`${n.deadline.firm ? `Must arrive by ${fmt(n.deadline.date)}.` : `Aim for arrival by ${fmt(n.deadline.date)}; the true deadline may be later.`} ${arrivalNote(result)}`);
      if (result.channel.kind === 'electronic') {
        L.push(''); L.push('Text for the electronic notice:'); L.push(''); L.push(n.message);
        L.push(''); L.push('Or, as a letter to the billing-error address:');
      }
      L.push(''); L.push('A separate sheet (not on the payment slip):'); L.push(''); L.push(n.letter);
    }
    if (!notices(result, choices).length) L.push(NO_NOTICE);
    L.push('');
  }
  L.push(rule); L.push('EVIDENCE INDEX'); L.push(rule);
  for (const e of evidenceIndex(result)) L.push(`${e.n}  ${e.what}${e.enclose ? '  [enclose a copy]' : ''}${e.keep ? '  [keep for your record]' : ''}  (file: ${e.name})`);
  L.push('');
  const ow = outsideWindow(result);
  if (ow && !result.exit) {
    L.push(rule); L.push('OLDER CHARGES: PAST THEIR 60 DAYS'); L.push(rule);
    L.push(...ow.lines);
    for (const i of [...ow.items, ...ow.maybe]) L.push(`- ${i.desc}, ${fmt(itemDate(i))}, ${dollars(i.disputed)}: ${STATUS_LABEL[i.window.status]}${i.include === undefined ? ' (not chosen yet)' : ''}`);
    if (ow.request) { L.push(''); L.push('Text you can use to ask:'); L.push(''); L.push(ow.request); }
    L.push('');
  }
  L.push(rule); L.push('FUTURE CHARGES'); L.push(rule);
  L.push(...stopNote(result)); L.push('');
  L.push(rule); L.push('WHAT IS STILL YOURS TO DO'); L.push(rule);
  const td = todo(result, choices);
  for (const t of td.filter(x => x.kind === 'do')) L.push(`[ ] ${todoWhen(t, result.today)}${t.urgent && t.date !== result.today ? ' (soon)' : ''}: ${t.text}`);
  const km = td.filter(x => x.kind === 'keep');
  if (km.length) { L.push(''); L.push('Keep in mind:'); for (const t of km) L.push(`- ${t.text}`); }
  L.push('');
  L.push(rule); L.push('TIMELINE FROM YOUR PAPERS'); L.push(rule);
  for (const e of result.timeline) L.push(`${fmt(e.date)}  ${e.text}  [${result.paperName[e.src && e.src.paper] || ''}${e.src ? ` line ${e.src.line}` : ''}]`);
  L.push('');
  L.push('This packet is preparation, not legal advice. It does not decide whether your cancellation took effect, what your agreement required, or whether any money comes back. Those decisions, and whether and how to send anything, are yours.');
  return L.join('\n');
}

export { addDays };
