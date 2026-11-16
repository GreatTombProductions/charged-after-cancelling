// The page. State lives only in this tab's memory until the person saves a
// case file. No network calls: the Content-Security-Policy in index.html
// sets connect-src 'none', and nothing here fetches.

import { emptyState, analyze, serialize, deserialize, whatChanged, STATUS_LABEL, dollars, itemDate, isOpenStatus, isClosedStatus } from './engine/case.mjs';
import { notices, evidenceIndex, outsideWindow, stopNote, todo, packetText, urgency, groupingAdvice, deadlineText, sendable, closedNote, arrivalNote, NO_NOTICE, todoWhen, daysWord } from './engine/outputs.mjs';
import { fmt, todayLocal } from './engine/dates.mjs';
import { KIND_LABELS } from './engine/papers.mjs';

let state = emptyState();
let dirty = false;
let changed = null;
let lastResult = null;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => todayLocal(new Date());

function nextPaperId() {
  const used = state.papers.map(p => Number(String(p.id).replace(/^p/, '')) || 0);
  return `p${Math.max(0, ...used) + 1}`;
}

function setStatus(text, kind) {
  const el = $('#status');
  el.textContent = text;
  el.dataset.status = kind;
}

function touch() {
  dirty = true;
  $('#saveState').textContent = 'Not saved yet. Closing this tab would lose it.';
  render();
}

// ------------------------------------------------------------- adding papers

function emlToText(raw) {
  if (!/^content-type:\s*multipart/im.test(raw) && !/content-transfer-encoding:\s*quoted-printable/i.test(raw)) return raw;
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const head = raw.slice(0, headerEnd).split(/\r?\n/).filter(l => /^(from|to|date|subject):/i.test(l)).join('\n');
  const parts = raw.split(/\r?\n--[^\r\n]+/);
  let body = parts.find(p => /content-type:\s*text\/plain/i.test(p)) || raw.slice(headerEnd);
  const qp = /content-transfer-encoding:\s*quoted-printable/i.test(body);
  body = body.replace(/^[\s\S]*?\r?\n\r?\n/, '');
  if (qp) body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return `${head}\n\n${body.trim()}`;
}

async function addFiles(files) {
  let added = 0;
  const problems = [];
  for (const file of files) {
    const id = nextPaperId();
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        setStatus(`Reading ${file.name} in this browser...`, 'busy');
        const { pdfToText } = await import('./pdftext.mjs');
        const { text, pages } = await pdfToText(await file.arrayBuffer());
        if (!text.trim()) { problems.push(`${file.name}: no text could be read (it may be a scanned picture). Type or paste its lines instead.`); continue; }
        state.papers.push({ id, name: file.name, text, origin: 'pdf', pages });
      } else {
        let text = await file.text();
        if (/\.eml$/i.test(file.name)) text = emlToText(text);
        state.papers.push({ id, name: file.name, text, origin: 'file' });
      }
      added++;
    } catch (e) {
      problems.push(`${file.name}: could not be read here (${e.message || e}).`);
    }
  }
  touch();
  const msg = `${added} paper${added === 1 ? '' : 's'} added.` + (problems.length ? ` ${problems.join(' ')}` : '');
  setStatus(msg, problems.length ? 'error' : statusKind());
}

function statusKind() {
  if (!state.papers.length) return 'empty';
  return lastResult && lastResult.exit ? 'exit' : 'ready';
}

// ------------------------------------------------------------- corrections

function setCorrection(id, raw, type) {
  let value = raw;
  if (type === 'number') value = raw === '' ? null : Math.round(parseFloat(raw) * 100) / 100;
  else if (raw === '') value = null;
  const current = findFact(id);
  state.corrections ||= {};
  if (current && current.extracted === value) delete state.corrections[id];
  else state.corrections[id] = { value, at: today() };
  touch();
}

function findFact(id) {
  const r = lastResult;
  if (!r) return null;
  const pool = [r.account.name, r.cancellation.date, r.channel.address];
  for (const st of r.statements) pool.push(st.closing, st.due, st.transmitted);
  for (const it of [...r.items, ...r.beforeCancel]) {
    if (it.kind === 'charge') pool.push(it.trans, it.post, it.amount);
    else pool.push(it.amount, it.promised);
  }
  return pool.find(f => f && f.id === id) || null;
}

function setChoice(path, value) {
  state.choices ||= {};
  const [group, key] = path.split('|');
  if (key === undefined) state.choices[group] = value;
  else {
    state.choices[group] ||= {};
    if (value === undefined) delete state.choices[group][key];
    else state.choices[group][key] = value;
  }
  touch();
}

// ------------------------------------------------------------------ render

function srcLink(src) {
  if (!src || !src.paper) return '';
  const p = state.papers.find(x => x.id === src.paper);
  if (!p) return '';
  return `<span class="from">from <button type="button" class="button small" data-show-src="${esc(src.paper)}" data-line="${src.line}">${esc(p.name)}, line ${src.line}</button></span>`;
}

function factInput(f, type, label) {
  if (!f) return '';
  const v = f.value ?? '';
  const step = type === 'number' ? ' step="0.01"' : '';
  const was = f.extracted === null || f.extracted === undefined ? 'nothing' : (type === 'date' ? fmt(f.extracted) : type === 'number' ? dollars(f.extracted) : f.extracted);
  return `<input type="${type}"${step} data-fact="${esc(f.id)}" data-type="${type}" value="${esc(v)}" aria-label="${esc(label)}">` +
    (f.corrected ? ` <span class="corrected">You corrected this (read as ${esc(was)}).</span>` : '');
}

function badge(status) {
  return `<span class="badge st-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function render() {
  let result = null;
  if (state.papers.length) {
    result = analyze(state, today());
  }
  lastResult = result;
  renderPapers(result);
  $('#ownWords').value = state.ownWords || '';
  const show = !!result;
  $('#results').hidden = !show;
  $('#keep').hidden = !show;
  if (!show) { setStatus('Add your papers to begin.', 'empty'); return; }
  if ($('#status').dataset.status === 'empty' || $('#status').dataset.status === 'ready' || $('#status').dataset.status === 'exit') {
    setStatus(result.exit ? result.exit.title : `${state.papers.length} paper${state.papers.length === 1 ? '' : 's'} read. Check what the page found below.`, statusKind());
  }
  renderChanged();
  renderExit(result);
  renderUrgent(result);
  renderQuestions(result);
  renderFound(result);
  renderCharges(result);
  renderNotice(result);
  renderEvidence(result);
  renderOutside(result);
  renderFuture(result);
  renderTodo(result);
  renderTimeline(result);
  $('#printArea').textContent = packetText(result, state.choices || {});
}

function renderPapers(result) {
  const parsed = result ? Object.fromEntries(result.parsed.map(x => [x.paper.id, x.data])) : {};
  const list = state.papers.map(p => {
    const kind = parsed[p.id] ? parsed[p.id].kind : '';
    const lines = p.text.split(/\r?\n/).map((l, k) => `<span id="src-${esc(p.id)}-L${k + 1}"><span class="ln">${k + 1}</span>${esc(l)}</span>`).join('\n');
    const opts = ['', ...Object.keys(KIND_LABELS)].map(k => `<option value="${k}"${(p.kindOverride || '') === k ? ' selected' : ''}>${k ? esc(KIND_LABELS[k]) : 'decide for me'}</option>`).join('');
    return `<div class="paper" data-paper="${esc(p.id)}">
      <div class="meta"><strong>${esc(p.name)}</strong><span class="kind">${esc(KIND_LABELS[kind] || 'not read')}${p.origin === 'pdf' ? ` (text read from a PDF, ${p.pages} page${p.pages === 1 ? '' : 's'}: check it)` : ''}</span>
      <label class="inline">Read as <select class="compact" data-kind-override="${esc(p.id)}" aria-label="Read ${esc(p.name)} as">${opts}</select></label>
      <button type="button" class="button small danger" data-remove="${esc(p.id)}">Remove</button></div>
      <details id="src-${esc(p.id)}"><summary>Show its text</summary><div class="source">${lines}</div></details>
    </div>`;
  }).join('');
  const wasOpen = $('#paperList') ? $('#paperList').open : state.papers.length <= 4;
  $('#papers').innerHTML = state.papers.length ? `<details id="paperList"${wasOpen ? ' open' : ''}><summary>Your papers (${state.papers.length})</summary>${list}</details>` : '';
}

function renderChanged() {
  const el = $('#changed');
  if (!changed) { el.innerHTML = ''; return; }
  const when = changed.days === 0 ? 'earlier today' : `${changed.days} day${changed.days === 1 ? '' : 's'} ago, on ${fmt(changed.savedOn)}`;
  el.innerHTML = `<section class="card changed-box" id="changedBox" aria-labelledby="changed-h"><h2 id="changed-h">Since you saved this (${esc(when)})</h2>
    <p>Every 60 days was counted again from today's date, ${esc(fmt(lastResult.today))}. Nothing was sent or done while you were away.</p>
    ${changed.lines.length ? `<ul>${changed.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p>No item changed status.</p>'}
    <button type="button" class="button small" data-dismiss-changed>Dismiss</button></section>`;
}

function renderExit(r) {
  $('#exit').innerHTML = r.exit ? `<section class="card exit-box" id="exitBox" aria-labelledby="exit-h"><h2 id="exit-h">${esc(r.exit.title)}</h2>
    ${r.exit.text.map(t => `<p>${esc(t)}</p>`).join('')}${srcLink(r.exit.src)}
    <p class="hint">If this is wrong (it is a credit card), change it under "What the page found".</p></section>` : '';
}

function renderUrgent(r) {
  const el = $('#urgent');
  const missing = r.exit ? [] : (r.missingStatements || []).filter(m => isOpenStatus(m.window.status));
  const soon = r.exit ? [] : sendable(r).filter(i => i.window.status === 'open' && i.window.daysLeft <= 10);
  if (!missing.length && !soon.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<h2 id="urgent-h">Nearest dates first</h2>
    ${missing.map(m => `<p class="${m.soon ? 'urgent-note' : ''}" data-missing-statement="${esc(m.sent || m.to || '')}">${esc(m.text)} ${srcLink(m.src)}</p>`).join('')}
    ${soon.map(i => `<p class="urgent-note">Your notice about ${esc(i.desc)} (${esc(fmt(itemDate(i)))}) must arrive by ${esc(fmt(i.window.arriveBy))} (${esc(daysWord(i.window.daysLeft))}). ${esc(arrivalNote(r))} See "Your notice" below.</p>`).join('')}`;
}

function renderQuestions(r) {
  const el = $('#questions');
  if (!r.questions.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<h2 id="questions-h">The page needs ${r.questions.length === 1 ? 'one answer' : `${r.questions.length} answers`}</h2>
    <p class="hint">Only questions whose answer changes the result are asked.</p>` + r.questions.map(q => {
    let control = '';
    if (q.kind === 'method') control = `<select data-fact="account:method" data-type="text" aria-label="${esc(q.text)}"><option value="">Choose</option>${q.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
    else if (q.kind === 'date') control = `<input type="date" data-fact="cancel:date" data-type="date" aria-label="${esc(q.text)}">`;
    else if (q.kind === 'closingDay') control = `<input type="number" min="1" max="31" data-fact="account:closingDay" data-type="text" aria-label="${esc(q.text)}" placeholder="e.g. 18">`;
    else if (q.kind === 'address') control = `<textarea rows="3" data-fact="channel:address" data-type="text" aria-label="${esc(q.text)}" placeholder="Name of the department&#10;P.O. Box or street&#10;City, state, ZIP"></textarea>
      <label>Does the "Your Billing Rights" section of that statement say you may also tell them electronically, and name how?</label>
      <select data-fact="channel:electronic" data-type="text" aria-label="Electronic notice stipulated"><option value="">I don't know</option><option value="yes">Yes, and it names how</option><option value="no">No, or it says they need not investigate</option></select>`;
    else if (q.kind === 'credit') control = `<select data-choice="creditFor|${esc(q.creditId)}" aria-label="${esc(q.text)}"><option value="__unset">Choose</option>${q.options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}</select>`;
    else if (q.kind === 'merchant') control = q.options.map(([k, l]) => `<label class="inline"><input type="checkbox" data-choice="merchants|${esc(k)}"> ${esc(l)}</label><br>`).join('');
    else if (q.kind === 'paidHow') control = `<select data-choice="paidHow|${esc(q.itemId)}" aria-label="${esc(q.text)}"><option value="__unset">Choose</option>${q.options.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}</select>`;
    else if (q.kind === 'contest') control = '<p>Choose for each charge under "Your charges" below.</p>';
    return `<div class="q" data-question="${esc(q.id)}"><p><strong>${esc(q.text)}</strong></p><p class="hint">${esc(q.why)}</p>${control}</div>`;
  }).join('');
}

function renderFound(r) {
  const m = r.method;
  const methodSelect = `<select data-fact="account:method" data-type="text" aria-label="Kind of card"><option value="">Not sure</option>${[['credit', 'Credit card'], ['debit', 'Debit card or bank account'], ['business', 'Business or company card'], ['prepaid', 'Prepaid card']].map(([v, l]) => `<option value="${v}"${m.value === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
  const c = r.cancellation;
  const stRows = r.statements.map(st => `<tr><td>${esc(r.paperName[st.paperId])} ${srcLink(st.closing.src)}</td>
    <td>${factInput(st.closing, 'date', 'Closing date')}</td><td>${factInput(st.due, 'date', 'Payment due date')}</td>
    <td>${factInput(st.transmitted, 'date', 'Date the statement was sent')}
      <div class="hint">${st.transmitted.value ? esc(`From ${st.transmitted.basis}.`) : 'Not in your papers. A dated "statement is ready" email or notice would give it.'}</div>${st.transmitted.value ? srcLink(st.transmitted.src) : ''}</td></tr>`).join('');
  const notes = [...r.conflicts.map(x => ['Check', x.text]), ...r.missing.map(x => ['Missing', x.text]), ...r.warnings.map(x => ['Note', x.text])];
  const merchants = r.merchants.length ? r.merchants.map(x => esc(x.name)).join(', ') : 'not identified yet';
  $('#found').innerHTML = `<h2 id="found-h">2. What the page found</h2>
    <p class="hint">Every date and amount below was read from one of your papers. Use "from ..." to see the line. Correct anything that is wrong; everything that depends on it changes.</p>
    <h3>The card</h3>
    <p>${esc([r.account.issuer, r.account.product].filter(Boolean).join(', ') || 'Card company not shown in your papers')}${r.account.ending ? `, ending ${esc(r.account.ending)}` : ''}.</p>
    <label for="nameInput">Name on the account</label><input id="nameInput" type="text" data-fact="person:name" data-type="text" value="${esc(r.account.name.value || '')}"> ${srcLink(r.account.name.src)}
    <label>What kind of card</label>${methodSelect} <span class="hint">${esc(m.why || '')}</span> ${srcLink(m.src)}
    <h3>The cancellation</h3>
    <p>Business: <strong>${merchants}</strong></p>
    <label for="cancelDate">Date you cancelled</label><input id="cancelDate" type="date" data-fact="cancel:date" data-type="date" value="${esc(c.date.value || '')}">
    ${c.date.corrected ? '<span class="corrected">You corrected this.</span>' : ''} <span class="hint">${c.basis ? esc(`Taken from ${c.basis}.`) : ''}</span>
    ${c.date.value ? `<p id="cancelCounts">The page counts a charge as made "after you cancelled" when it is after <strong>${esc(fmt(c.date.value))}</strong>.${c.until ? ` ${esc(c.until.who[0].toUpperCase() + c.until.who.slice(1))} also gives a later date, <strong>${esc(fmt(c.until.date))}</strong> ("${esc(c.until.words)}") ${srcLink(c.until.src)}. Which of the two dates counts is not something this page decides. ${(() => { const n = [...r.items, ...r.beforeCancel].filter(i => i.betweenDates).length; return n ? `${n === 1 ? 'One charge falls' : `${n} charges fall`} between them; the page does not suggest yes or no for ${n === 1 ? 'it' : 'them'}, and you choose under "Your charges".` : 'No charge in your papers falls between them.'; })()}` : ''}</p>` : ''}
    <ul>${c.evidence.filter(e => e.kind !== 'own-words').map(e => `<li>${esc(fmt(e.date))}: ${esc(e.role === 'request' ? 'you asked to cancel' : e.role === 'confirmation' ? `${e.by} replied` : 'your record')}${e.quote ? `: "${esc(e.quote)}"` : ''}${e.effective ? ` (effective ${esc(fmt(e.effective.value))})` : ''} ${srcLink(e.src)}</li>`).join('')}</ul>
    ${r.contract ? `<h3>The business's account of the agreement</h3><div class="flag"><p><strong>You:</strong> ${esc(r.contract.personSays ? `asked to cancel on ${fmt(r.contract.personSays.date)}${r.contract.personSays.quote ? `: "${r.contract.personSays.quote}"` : ''}` : 'cancelled')}</p>
      <p><strong>The business:</strong> ${r.contract.claims.filter((x, k, a) => a.findIndex(y => y.words === x.words) === k).map(x => `"${esc(x.words)}" ${srcLink(x.src)}`).join(' ')}</p>
      <p>Which of these is right depends on the agreement itself and the law that applies to it. This page does not decide it. The agreement would show what was promised; someone who can read it for your state may help. You choose which charges to dispute.</p></div>` : ''}
    ${r.statements.length ? `<h3>Your statements</h3><div class="table-scroll"><table><thead><tr><th>Statement</th><th>Closing date (last day it covers)</th><th>Payment due</th><th>Sent on (starts its 60 days)</th></tr></thead><tbody>${stRows}</tbody></table></div>` : ''}
    ${notes.length ? `<h3>Gaps and conflicts</h3><ul id="gaps">${notes.map(([k, t]) => `<li><strong>${esc(k)}:</strong> ${esc(t)}</li>`).join('')}</ul>` : ''}
    ${r.otherCharges.length ? `<details><summary>Other charges in your papers (${r.otherCharges.length}), not from the business you cancelled</summary><ul>${r.otherCharges.map(t => `<li>${esc(t.desc)} ${esc(dollars(t.amount.value))} ${srcLink(t.src)}</li>`).join('')}</ul></details>` : ''}`;
}

function itemCard(it, r) {
  const w = it.window;
  const urgent = isOpenStatus(w.status) && w.daysLeft <= 10 && it.include !== false;
  const facts = it.kind === 'charge'
    ? `${it.shown && !it.trans.value && !it.post.value ? `<div class="shown-date"><label>Date in your app list</label><strong>${esc(fmt(it.shown))}</strong> ${srcLink(it.src)}
         <div class="hint">Your app list gives one date and does not say which kind it is. The page uses it as it is. Fill in the two dates below only if a statement shows them; nothing else is needed now.</div></div>` : ''}
       <div><label>Transaction date <span class="hint">(the day the business charged it)</span></label>${factInput(it.trans, 'date', 'Transaction date')}</div>
       <div><label>Posting date <span class="hint">(the day it reached your account)</span></label>${factInput(it.post, 'date', 'Posting date')}</div>
       <div><label>Amount charged</label>${factInput(it.amount, 'number', 'Amount')}</div>
       <div><label>First statement showing it</label>${it.statement ? esc(it.statement.label) : 'none in your papers'}</div>`
    : `<div><label>Promised on</label>${factInput(it.promised, 'date', 'Date the refund was promised')}</div>
       <div><label>Amount promised</label>${factInput(it.amount, 'number', 'Amount promised')}</div>
       <div><label>Statement it should have appeared on</label><select data-choice="ftcStatement|${esc(it.id)}" aria-label="Statement the credit should have appeared on">${it.statementChoice.options.map(([v, l]) => `<option value="${esc(v)}"${it.statement && it.statement.id === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`;
  const credits = it.credits.length ? `<p>Credited: ${it.credits.map(c => `${esc(dollars(c.amount))} on ${esc(fmt(c.date))} (${esc(c.basis)}) ${srcLink(c.src)}`).join('; ')}. Amount in dispute: <strong>${esc(dollars(it.disputed))}</strong>.</p>` : '';
  const sendableStatus = !['closed', 'closed-bound', 'not-started', 'pending', 'credited', 'exit'].includes(w.status);
  // One choice for everything the page drafts: the notice and the request about older charges (cold walk 2).
  const suggested = it.proposed === undefined ? null : (it.proposed ? 'yes' : 'no');
  const opts = [['__unset', suggested ? `${suggested === 'yes' ? 'Yes' : 'No'} (the page suggests this)` : 'Choose', !it.choice]];
  if (suggested !== 'yes' || it.choice === 'yes') opts.push(['yes', 'Yes', it.choice === 'yes']);
  if (suggested !== 'no' || it.choice === 'no') opts.push(['no', 'No', it.choice === 'no']);
  const whereNot = w.status === 'pending' || w.status === 'not-started' ? 'It is not in the notice yet: it is not on a statement.'
    : w.status === 'credited' ? 'It is not in the notice: nothing is left to dispute.'
    : '';
  const includeSel = w.status === 'exit' ? '' : `<label>Do you want to dispute this ${it.kind === 'ftc' ? 'item' : 'charge'}?</label>
    <select data-choice="contest|${esc(it.id)}" aria-label="Dispute ${esc(it.desc)} ${esc(fmt(itemDate(it)))}">
      ${opts.map(([v, l, sel]) => `<option value="${v}"${sel ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
    <p class="hint">Your answer covers everything the page drafts: the notice, and the text for asking about older charges. "No" leaves this charge out of all of them; it stays here in your record.${it.include === false && it.choice === 'no' ? ' <strong>You chose not to dispute it.</strong>' : ''}</p>
    ${whereNot ? `<p class="hint">${whereNot}</p>` : ''}`;
  const closed = closedNote(it, r);
  const reason = it.include === true && sendableStatus ? `<label for="reason-${esc(it.id)}">Why you believe it is an error (your words; the page drafted it)</label>
    <textarea id="reason-${esc(it.id)}" rows="5" data-choice-reason="${esc(it.id)}">${esc(it.reason)}</textarea>` : '';
  return `<div class="item${urgent ? ' urgent' : ''}" data-item="${esc(it.id)}" data-status="${esc(w.status)}">
    <h3>${esc(it.desc)}: ${esc(dollars(it.disputed))}${it.kind === 'charge' ? `, ${esc(fmt(itemDate(it)))}` : ''}</h3>
    ${badge(w.status)} <strong class="deadline">${esc(deadlineText(w))}</strong> ${srcLink(it.src)}
    ${closed ? `<p class="closed-note">${esc(closed)}</p>` : ''}
    <div class="facts">${facts}</div>${credits}
    ${it.flags.map(f => `<div class="flag">${esc(f)}</div>`).join('')}
    <details${urgent || w.status === 'may-be-closed' ? ' open' : ''}><summary>How this was worked out</summary><ul class="why">${[...(w.why || []), ...(it.carriedNote ? [it.carriedNote] : [])].map(x => `<li>${esc(x)}</li>`).join('')}
      ${it.related && it.related.length ? `<li>Interest on later statements (${it.related.map(x => `${esc(dollars(x.amount))} on ${esc(fmt(x.date))}`).join(', ')}) is not a separate error; it is mentioned with this item.</li>` : ''}</ul></details>
    ${includeSel}${reason}</div>`;
}

function renderCharges(r) {
  const before = r.beforeCancel.length ? `<details><summary>Charges from the same business before your cancellation date (${r.beforeCancel.length})</summary>${r.beforeCancel.map(it => itemCard(it, r)).join('')}</details>` : '';
  const credits = r.credits.filter(c => c.temporary).map(c => `<p class="flag">Temporary credit ${esc(dollars(c.amount))} on ${esc(fmt(c.date))}: a temporary credit is not a final result. Your card company still has to finish its review. ${srcLink(c.src)}</p>`).join('');
  $('#charges').innerHTML = `<h2 id="charges-h">3. Your charges</h2>
    <p class="hint">Each charge with the statement it first appeared on, and how long a notice about it has to reach your card company: 60 days from the day that statement was sent. Dates are counted from today, ${esc(fmt(r.today))}.</p>
    ${r.items.length ? r.items.map(it => itemCard(it, r)).join('') : '<p>No charges from the business you cancelled were found yet. Add your statements, or answer the question above.</p>'}
    ${credits}${before}`;
}

function renderNotice(r) {
  const el = $('#notice');
  if (r.exit) { el.innerHTML = '<h2 id="notice-h">4. Your notice</h2><p>No credit-card notice is prepared for this card (see the box at the top).</p>'; return; }
  const ch = r.channel;
  const ch_ = state.choices || {};
  const ns = notices(r, ch_);
  const adv = groupingAdvice(r);
  const radios = (name, opts, cur) => opts.map(([v, l]) => `<label class="inline"><input type="radio" name="${name}" data-choice="${name}" value="${v}"${cur === v ? ' checked' : ''}> ${esc(l)}</label>`).join('<br>');
  const elecSelect = !ch.rights ? `<label>Does the "Your Billing Rights" section of your statement say a notice sent electronically counts, and name how?</label>
    <select data-fact="channel:electronic" data-type="text"><option value=""${!state.corrections['channel:electronic'] ? ' selected' : ''}>I don't have it / don't know</option><option value="yes"${ch.kind === 'electronic' ? ' selected' : ''}>Yes, and it names how</option><option value="no"${state.corrections['channel:electronic'] && state.corrections['channel:electronic'].value === 'no' ? ' selected' : ''}>No</option></select>` : '';
  el.innerHTML = `<h2 id="notice-h">4. Your notice</h2>
    <p class="hint">A billing-error notice is a letter (or, where your statement allows, a message) telling your card company that a charge on your statement is wrong and why. If it arrives within 60 days of the statement being sent, the card company has to look into the charge and answer you in writing.</p>
    <div id="channel" data-channel="${esc(ch.kind)}">${ch.notes.map(n => `<p>${esc(n)}</p>`).join('')}</div>
    ${ch.address.value ? `<p>Send it to:</p><div class="address" id="billingAddress">${esc(ch.address.value)}</div> ${srcLink(ch.address.src)}` : '<p id="billingAddress" class="flag">Billing-error address: not in your papers.</p>'}
    <details><summary>Correct the address</summary><textarea rows="3" data-fact="channel:address" data-type="text" aria-label="Billing-error address">${esc(ch.address.value || '')}</textarea></details>
    ${elecSelect}
    ${urgency(r).map(u => `<p class="urgent-note">${esc(u.text)}</p>`).join('')}
    ${adv ? `<h3>One notice or separate ones</h3><p>${esc(adv)}</p>${radios('grouping', [['one', 'One notice listing every item'], ['split', 'A separate notice for each item']], ch_.grouping || 'one')}` : ''}
    <h3>Account number in the notice</h3>
    <p class="hint">Your card company needs your name and enough to find the account. The full number is the surest; you decide. This page never asks for it.</p>
    ${radios('accountIdent', [['ending', `The last digits (${r.account.ending || 'not known'})`], ['blank', 'A blank line where I write the full number by hand']], ch_.accountIdent || 'ending')}
    ${r.items.some(i => i.include === true && (i.window.status === 'closed' || i.window.status === 'closed-bound')) ? `<p><label class="inline"><input type="checkbox" data-choice="mentionClosed"${ch_.mentionClosed ? ' checked' : ''}> Also list the older charges past their 60 days, marked as such, at the end of the notice</label></p>` : ''}
    ${ns.length ? ns.map((n, k) => `<div class="notice" data-notice="${k}"><h3>${esc(n.title)}</h3>
      <p><strong>${n.deadline ? esc(n.deadline.firm ? `Must arrive by ${fmt(n.deadline.date)}.` : `Aim for it to arrive by ${fmt(n.deadline.date)}. The true deadline may be later but is not known.`) : 'Its deadline is not known from your papers. Sooner is safer.'}</strong>${n.deadline ? ` ${esc(arrivalNote(r))}` : ''}</p>
      ${ch.kind === 'electronic' ? `<p>Text to paste into the channel your statement names (${esc(ch.means)}):</p><pre class="out" id="message-${k}">${esc(n.message)}</pre><button type="button" class="button small" data-copy="message-${k}">Copy this text</button><p>Or, by mail to the billing-error address:</p>` : '<p>Print it, or copy it, on a separate sheet. Do not write it on the payment slip.</p>'}
      <pre class="out" id="letter-${k}">${esc(n.letter)}</pre><button type="button" class="button small" data-copy="letter-${k}">Copy the letter</button></div>`).join('')
      : `<p id="noNotice">${esc(NO_NOTICE)} See "Your charges" and the questions above.</p>`}`;
}

function renderEvidence(r) {
  const ev = evidenceIndex(r);
  $('#evidence').innerHTML = `<h2 id="evidence-h">5. Evidence index</h2>
    <p class="hint">Send copies, never originals. Your own notes are not listed.</p>
    <div class="table-scroll"><table><thead><tr><th>No.</th><th>What it is</th><th>File</th><th>Use</th></tr></thead><tbody>
    ${ev.map(e => `<tr><td>${e.n}</td><td>${esc(e.what)}</td><td>${esc(e.name)}</td><td>${e.enclose ? 'Enclose a copy' : e.keep ? 'Keep: shows when a statement was sent' : 'Keep'}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderOutside(r) {
  const ow = outsideWindow(r);
  const el = $('#outside');
  if (!ow || r.exit) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `<h2 id="outside-h">6. Older charges: past their 60 days</h2>${ow.lines.map(l => `<p>${esc(l)}</p>`).join('')}
    <ul>${[...ow.items, ...ow.maybe].map(i => `<li>${esc(i.desc)}, ${esc(fmt(itemDate(i)))}, ${esc(dollars(i.disputed))}: ${esc(STATUS_LABEL[i.window.status])}${i.include === undefined ? ' (not chosen yet)' : ''}</li>`).join('')}</ul>
    ${ow.request ? `<details><summary>Text you can use to ask</summary><pre class="out" id="outsideRequest">${esc(ow.request)}</pre><button type="button" class="button small" data-copy="outsideRequest">Copy</button></details>` : ''}`;
}

function renderFuture(r) {
  $('#future').innerHTML = `<h2 id="future-h">7. Future charges</h2><ul>${stopNote(r).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

function renderTodo(r) {
  const td = todo(r, state.choices || {});
  const keep = td.filter(t => t.kind === 'keep');
  $('#todo').innerHTML = `<h2 id="todo-h">8. What is still yours to do</h2>
    <ol class="todo">${td.filter(t => t.kind === 'do').map(t => `<li${t.urgent ? ' class="soon"' : ''}><span class="date">${esc(todoWhen(t, r.today))}</span>${t.urgent && t.date !== r.today ? ' <strong>(soon)</strong>' : ''}: ${esc(t.text)}</li>`).join('')}</ol>
    ${keep.length ? `<h3>Keep in mind</h3><ul>${keep.map(t => `<li>${esc(t.text)}</li>`).join('')}</ul>` : ''}`;
}

function renderTimeline(r) {
  $('#timeline').innerHTML = `<details><summary id="timeline-h">Timeline from your papers (${r.timeline.length} entries)</summary>
    <div class="table-scroll"><table><tbody>${r.timeline.map(e => `<tr><td>${esc(fmt(e.date))}</td><td>${esc(e.text)}</td><td>${srcLink(e.src)}</td></tr>`).join('')}</tbody></table></div></details>`;
}

// ------------------------------------------------------------------ events

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.id === 'fileInput') { await addFiles([...t.files]); t.value = ''; return; }
  if (t.id === 'openCase') {
    const f = t.files[0]; t.value = '';
    if (!f) return;
    try {
      const loaded = deserialize(await f.text());
      state = loaded;
      changed = whatChanged(state.snapshot, analyze(state, today()));
      dirty = false;
      setStatus(`Opened ${f.name}: ${state.papers.length} papers.`, 'ready');
      render();
      $('#saveState').textContent = `Opened your work saved on ${fmt(state.savedAt)}.`;
    } catch (err) { setStatus(err.message, 'error'); }
    return;
  }
  if (t.dataset.fact) { setCorrection(t.dataset.fact, t.value.trim ? t.value.trim() : t.value, t.dataset.type); return; }
  if (t.dataset.kindOverride) {
    const p = state.papers.find(x => x.id === t.dataset.kindOverride);
    if (t.value) p.kindOverride = t.value; else delete p.kindOverride;
    touch(); return;
  }
  if (t.dataset.choiceReason) { setChoice(`reasons|${t.dataset.choiceReason}`, t.value); return; }
  if (t.dataset.choice) {
    const path = t.dataset.choice;
    if (path.startsWith('contest|')) setChoice(path, t.value === '__unset' ? undefined : t.value === 'yes');
    else if (path.startsWith('merchants|')) setChoice(path, t.checked);
    else if (path === 'mentionClosed') setChoice(path, t.checked);
    else if (t.type === 'radio') setChoice(path, t.value);
    else setChoice(path, t.value === '__unset' ? undefined : t.value);
  }
});

document.addEventListener('input', e => {
  if (e.target.id === 'ownWords') { state.ownWords = e.target.value; dirty = true; $('#saveState').textContent = 'Not saved yet.'; }
});

document.addEventListener('click', async e => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'pasteAdd') {
    const text = $('#pasteText').value;
    if (!text.trim()) { setStatus('Nothing to add: the text box is empty.', 'error'); return; }
    state.papers.push({ id: nextPaperId(), name: $('#pasteName').value.trim() || `pasted text ${state.papers.length + 1}`, text, origin: 'paste' });
    $('#pasteText').value = ''; $('#pasteName').value = '';
    setStatus('Text added.', 'ready');
    touch(); return;
  }
  if (t.dataset.remove) {
    state.papers = state.papers.filter(p => p.id !== t.dataset.remove);
    touch(); return;
  }
  if (t.dataset.showSrc) {
    const d = document.getElementById(`src-${t.dataset.showSrc}`);
    if ($('#paperList')) $('#paperList').open = true;
    if (d) {
      d.open = true;
      document.querySelectorAll('.source mark').forEach(m => m.replaceWith(...m.childNodes));
      const line = document.getElementById(`src-${t.dataset.showSrc}-L${t.dataset.line}`);
      if (line) { const m = document.createElement('mark'); line.replaceWith(m); m.appendChild(line); m.scrollIntoView({ block: 'center' }); }
    }
    return;
  }
  if (t.dataset.copy) {
    const text = document.getElementById(t.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); t.textContent = 'Copied'; }
    catch { const r = document.createRange(); r.selectNodeContents(document.getElementById(t.dataset.copy)); getSelection().removeAllRanges(); getSelection().addRange(r); t.textContent = 'Selected: press Ctrl+C or Cmd+C'; }
    return;
  }
  if (t.hasAttribute('data-dismiss-changed')) { changed = null; render(); return; }
  if (t.id === 'saveCase') {
    const r = analyze(state, today());
    const text = serialize(state, r);
    state.savedAt = r.today;
    download(`charged-after-cancelling-case-${r.today}.json`, text, 'application/json');
    dirty = false;
    $('#saveState').textContent = `Saved as a file on your device (${fmt(r.today)}). This page kept no copy. Delete that file to delete your work.`;
    return;
  }
  if (t.id === 'downloadPacket') {
    const r = analyze(state, today());
    download(`charged-after-cancelling-packet-${r.today}.txt`, packetText(r, state.choices || {}), 'text/plain');
    return;
  }
  if (t.id === 'printPacket') { render(); window.print(); return; }
  if (t.id === 'clearAll') {
    if (!confirm('Remove everything from this page? Anything you have not saved as a file is lost.')) return;
    state = emptyState(); changed = null; dirty = false;
    $('#saveState').textContent = '';
    render();
  }
});

window.addEventListener('beforeunload', e => {
  if (dirty && state.papers.length) { e.preventDefault(); e.returnValue = ''; }
});

render();
