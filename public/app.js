// Number Crunch client. All behaviour lives here: the page's CSP forbids inline scripts and handlers.
import { START_NUMBERS, UNREACHABLE, ALL_TARGETS, applyStep, isTargetHit } from '/game-rules.js';
import { openAccountWindow } from '/vendor/bcm-auth-browser.js';
import { cheer, groan, hush, isSoundOn, setSound } from '/fanfare.js';

const SSO_FLAG = 'blackcat.sso.attempted.v1';
const OP_SYMBOLS = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const OVERLAYS = ['howToPlayOverlay', 'statsOverlay', 'pickerOverlay']; // topmost first
const RANKS = ['gold', 'silver', 'bronze', '', ''];
const BADGES = { first: ['✨', 'First solve'], pb: ['🏅', 'New personal best'], global: ['🏆', 'New global best'] };
const REVEAL_WAIT_MS = 1200; // the longest a win's result waits for its save
const $ = (id) => document.getElementById(id);

// ===== STATE =====
const account = { user: null, accountUrl: null, records: {} };
let target = null, numbers = [], selectedNums = [], selectedOp = null;
let moves = [];             // [{numbers before the step, step: {a, b, op}}], the undo stack and the solution
let round = null;           // {target, roundId: Promise} for a signed-in player's server round
let gameSeq = 0, lbSeq = 0; // drop async results that belong to an earlier game or leaderboard load
let timerStart = 0, timerInterval = null;
let resultMs = 0;           // the result time: the client's until the server answers with the saved one
let tier = 'win', cheered = null; // how this win is celebrated ('first', 'pb' or 'global' once saved), and what has played
let lbTab = 'global', lb = { state: 'loading', entries: [] };
let statsTab = 'personal', globalBests = null, bestsFailed = false;
let overlayReturn = null;
let accountCleanup = () => {}, accountRegister = false;

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
const fmtGain = (ms) => ms < 100 ? (ms / 1000).toFixed(2) + 's' : fmt(ms);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const formatNum = (n) => Number.isInteger(n) ? n.toString() : parseFloat(n.toFixed(4)).toString();
const randomTarget = () => ALL_TARGETS[Math.floor(Math.random() * ALL_TARGETS.length)];
// Focus left on a control that is being hidden would let Enter or Space activate it unseen.
const blurWithin = (node) => { if (node.contains(document.activeElement)) document.activeElement.blur(); };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ===== AUTH =====
// sessionStorage can throw (blocked storage); then silent SSO is skipped rather than risking a redirect loop.
function ssoAttempted() { try { return sessionStorage.getItem(SSO_FLAG) !== null; } catch { return true; } }
function markSsoAttempted() { try { sessionStorage.setItem(SSO_FLAG, '1'); return true; } catch { return false; } }

async function boot() {
  const params = new URLSearchParams(location.search);
  const callbackFailed = location.pathname === '/login' || params.has('error');
  const ssoDenied = params.has('auth_error');
  if (callbackFailed || ssoDenied) history.replaceState(null, '', '/');
  let me = null;
  // A timeout counts as unavailable, like any other failure.
  try { me = await api('/api/me', undefined, AbortSignal.timeout?.(10_000)); } catch { /* shown below */ }
  if (me) setAccount(me);
  if (me?.user) return enterGame();
  if (me && !callbackFailed && !ssoDenied && !ssoAttempted() && markSsoAttempted()) {
    return location.replace('/api/auth/login?next=%2F&silent=1');
  }
  showSignIn(!me ? 'Accounts are unavailable right now. You can still play as a guest.'
    : callbackFailed ? 'Sign-in did not finish. Please try again.' : '');
}

function setAccount(me) {
  account.user = me.user ?? null;
  account.accountUrl = me.accountUrl ?? null;
  account.records = me.records ?? {};
  renderAccount();
}

function showSignIn(message) {
  $('authStatus').hidden = true;
  $('authOptions').hidden = false;
  $('authError').textContent = message;
}

function enterGame() {
  $('authOverlay').classList.add('hidden');
  blurWithin($('authOverlay'));
  $('startScreen').classList.remove('hidden');
  $('gameContent').classList.add('hidden');
}

// Must run synchronously inside a click handler so the browser allows the popup.
function openAccount(register) {
  accountCleanup();
  accountRegister = register;
  showAccountNotice('Finish signing in in the Black Cat Matrix window. Your game stays here.', true);
  accountCleanup = openAccountWindow({
    next: '/', register, onSignedIn: accountSignedIn, onError: (message) => showAccountNotice(message, false),
  });
}

function showAccountNotice(message, waiting) {
  const msg = $('accountMessage');
  msg.textContent = message;
  msg.setAttribute('role', waiting ? 'status' : 'alert');
  $('accountRetry').textContent = waiting ? 'Reopen sign-in' : 'Try again';
  const link = $('accountFallback');
  link.hidden = waiting;
  link.href = '/api/auth/login?next=%2F' + (accountRegister ? '&mode=register' : '');
  if (!$('accountDialog').open) $('accountDialog').showModal();
}

function closeAccount() {
  accountCleanup();
  accountCleanup = () => {};
  if ($('accountDialog').open) $('accountDialog').close();
}

// Updates the account in place: the board, timer and current round are left alone.
async function accountSignedIn() {
  try { setAccount(await api('/api/me')); }
  catch { return showAccountNotice('Could not refresh your account. Please try again.', false); }
  closeAccount();
  if (account.user && !$('authOverlay').classList.contains('hidden')) enterGame();
  else if (target !== null) loadLeaderboard(target);
}

function signOut() {
  markSsoAttempted();
  $('logoutForm').submit();
}

// ===== API =====
async function api(path, body, signal) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store', signal } : {
    method: 'POST', cache: 'no-store', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`${path} failed with ${res.status}`), { status: res.status });
  return res.json();
}

// A 401 mid-play means the session ended: the account is refreshed in place (the top bar may turn guest),
// and the board and timer are left alone.
function sessionExpired(error) {
  if (error?.status !== 401) return false;
  api('/api/me').then(setAccount, () => {});
  return true;
}

function startRound(t) {
  const roundId = api('/api/rounds', { target: t }).then((r) => r.roundId);
  roundId.catch(sessionExpired); // a 401 refreshes the account now; any failed start is reported when the round finishes
  return roundId;
}

async function saveSolve(r, steps, clientMs) {
  const seq = gameSeq;
  const say = (text, best = false) => {
    if (seq !== gameSeq) return;
    $('resultNote').textContent = text;
    $('resultNote').classList.toggle('best', best);
  };
  if (!r) return say(account.user ? 'Times save from your next round.' : 'Sign in to save your times.');
  say('Saving your time…');
  try {
    const roundId = await r.roundId;
    const prev = account.records[r.target];
    const res = await api(`/api/rounds/${encodeURIComponent(roundId)}/finish`, { steps, clientMs });
    account.records[r.target] = { bestMs: res.bestMs, solveCount: res.solveCount };
    if (seq === gameSeq) {
      resultMs = res.recordedMs; $('resultTime').textContent = `⏱ ${fmt(resultMs)}`; // show what was saved
      tier = !res.personalBest ? 'win' : res.globalBest ? 'global' : prev ? 'pb' : 'first';
      say(tier === 'global' ? `The fastest anyone has solved ${r.target}!`
        : tier === 'first' ? `First solve! ${Object.keys(account.records).length} of ${ALL_TARGETS.length} numbers solved.`
        : tier === 'pb' ? `${fmtGain(prev.bestMs - res.bestMs)} faster than your old best of ${fmt(prev.bestMs)}`
        : `Saved. Your best: ${fmt(res.bestMs)}`, tier !== 'win');
      if (cheered && isShown('resultOverlay')) celebrate(); // the result is already up: the bigger fanfare follows
    }
  } catch (error) {
    say(sessionExpired(error) ? 'Your sign-in expired. Sign in again to save your times.' : "Couldn't save this time.");
  }
  if (r.target === target) { renderBestTime(); loadLeaderboard(target); }
}

async function loadLeaderboard(t) {
  const seq = ++lbSeq;
  lb = { state: 'loading', entries: [] };
  renderLb();
  try {
    const { entries } = await api(`/api/leaderboard/${t}`);
    if (seq === lbSeq) lb = { state: 'ready', entries };
  } catch {
    if (seq === lbSeq) lb = { state: 'error', entries: [] };
  }
  if (seq === lbSeq) renderLb();
}

// ===== GAME =====
function playTarget(n) {
  closeOverlays();
  $('startScreen').classList.add('hidden');
  $('gameContent').classList.remove('hidden');
  newGame(n);
}

function newGame(t = randomTarget()) {
  gameSeq++;
  target = t; numbers = [...START_NUMBERS]; selectedNums = []; selectedOp = null; moves = [];
  tier = 'win'; cheered = null;
  round = account.user ? { target: t, roundId: startRound(t) } : null;
  hideResult();
  $('targetNumber').textContent = t;
  $('lbTitle').textContent = `Best Times — Target: ${t}`;
  renderBoard();
  startTimer(); renderBestTime();
  lbTab = 'global'; loadLeaderboard(t);
}

function selectNumber(i) {
  if (i >= numbers.length) return;
  const pos = selectedNums.indexOf(i);
  if (pos !== -1) selectedNums.splice(pos, 1);
  else if (selectedNums.length < 2) selectedNums.push(i);
  else { selectedNums.shift(); selectedNums.push(i); }
  renderBoard();
}

function selectOp(op) {
  selectedOp = selectedOp === op ? null : op;
  renderBoard();
}

function compute() {
  if (selectedNums.length !== 2 || !selectedOp) return;
  const step = { a: selectedNums[0], b: selectedNums[1], op: selectedOp };
  const next = applyStep(numbers, step);
  if (!next) return shakeExpression(); // the only invalid step left here is division by zero
  moves.push({ numbers, step });
  numbers = next; selectedNums = []; selectedOp = null;
  renderBoard();
  $('numbersSection').lastElementChild.classList.add('result-new');
  if (numbers.length === 1) finishGame();
}

function finishGame() {
  const ms = Date.now() - timerStart;
  stopTimer();
  $('timer').textContent = fmt(ms);
  resultMs = ms;
  const won = isTargetHit(numbers[0], target), seq = gameSeq;
  const saved = won && saveSolve(round, moves.map((m) => m.step), ms);
  // A win waits a moment for its save, so a personal best can lead the celebration instead of following it.
  Promise.all([wait(400), Promise.race([saved, wait(REVEAL_WAIT_MS)])]).then(() => { if (seq === gameSeq) showResult(won); });
}

function shakeExpression() {
  const e = $('expression');
  e.textContent = "Can't divide by zero!";
  e.classList.add('error');
  setTimeout(renderExpression, 1200);
}

// A finished board is final: its round has already been submitted.
function undoLast() {
  if (!moves.length || numbers.length === 1) return;
  numbers = moves.pop().numbers; selectedNums = []; selectedOp = null;
  renderBoard();
}

function startTimer() {
  stopTimer();
  timerStart = Date.now();
  const t = $('timer');
  t.textContent = fmt(0);
  timerInterval = setInterval(() => { t.textContent = fmt(Date.now() - timerStart); }, 100);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }

// ===== RENDERING =====
function renderAccount() {
  const { user, accountUrl } = account;
  $('guestBadge').hidden = !!user;
  const badge = $('userBadge');
  badge.hidden = !user;
  if (user) {
    badge.textContent = '🏆 ' + user.displayName;
    if (accountUrl) badge.href = accountUrl; else badge.removeAttribute('href');
  }
  $('signInBtn').hidden = !!user;
  $('statsBtn').hidden = $('signOutBtn').hidden = !user;
  renderBestTime(); renderLb();
}

function renderBoard() { renderNumbers(); renderOps(); renderExpression(); updateButtons(); }

// Tiles are reused while their count holds, so a focused tile keeps focus for keyboard players.
function renderNumbers() {
  const s = $('numbersSection');
  while (s.children.length > numbers.length) s.lastElementChild.remove();
  while (s.children.length < numbers.length) {
    const tile = el('button', 'num-tile');
    tile.type = 'button'; tile.dataset.action = 'pick-number';
    s.append(tile);
  }
  numbers.forEach((n, i) => {
    const tile = s.children[i], on = selectedNums.includes(i);
    tile.className = 'num-tile' + (on ? ' selected' : '');
    tile.dataset.index = i;
    tile.textContent = formatNum(n);
    tile.setAttribute('aria-pressed', on);
  });
}

function renderOps() {
  for (const b of document.querySelectorAll('.op-btn')) {
    b.classList.toggle('selected', b.dataset.op === selectedOp);
    b.setAttribute('aria-pressed', b.dataset.op === selectedOp);
  }
}

function renderExpression() {
  const e = $('expression');
  e.classList.remove('error');
  if (!selectedNums.length && !selectedOp) { e.textContent = '\u00a0'; e.classList.remove('ready'); return; }
  const num = (k) => k < selectedNums.length ? formatNum(numbers[selectedNums[k]]) : '?';
  e.textContent = `${num(0)} ${selectedOp ? OP_SYMBOLS[selectedOp] : '?'} ${num(1)}`;
  e.classList.toggle('ready', selectedNums.length === 2 && !!selectedOp);
}

function updateButtons() {
  $('computeBtn').disabled = !(selectedNums.length === 2 && selectedOp);
  $('undoBtn').disabled = !moves.length || numbers.length === 1;
}

function renderBestTime() {
  const rec = account.user && target !== null && account.records[target];
  $('bestTime').textContent = rec ? `★ Your best: ${fmt(rec.bestMs)}` : '';
}

function lbRow(rank, name, value) {
  const row = el('div', 'lb-entry');
  row.append(rank, el('span', 'lb-name', name), value);
  return row;
}

function renderLb() {
  for (const b of document.querySelectorAll('[data-action="lb-tab"]')) b.setAttribute('aria-pressed', b.dataset.tab === lbTab);
  const c = $('lbEntries');
  if (lbTab === 'personal') {
    const rec = account.user && account.records[target];
    if (!account.user) return c.replaceChildren(el('div', 'lb-empty', 'Sign in to track your times'));
    if (!rec) return c.replaceChildren(el('div', 'lb-empty', "You haven't solved this number yet"));
    return c.replaceChildren(
      lbRow(el('span', 'lb-rank gold', '★'), 'Best Time', el('span', 'lb-time', fmt(rec.bestMs))),
      lbRow(el('span', 'lb-rank blue', '×'), 'Times Solved', el('span', 'lb-time plain', rec.solveCount)),
    );
  }
  if (lb.state !== 'ready' || !lb.entries.length) {
    const text = lb.state === 'loading' ? 'Loading…' : lb.state === 'error' ? "Couldn't load times." : 'No times yet — be the first!';
    return c.replaceChildren(el('div', 'lb-empty', text));
  }
  c.replaceChildren(...lb.entries.map((e, i) =>
    lbRow(el('span', `lb-rank ${RANKS[i]}`, i + 1), e.name + (e.you ? ' (you)' : ''), el('span', 'lb-time', fmt(e.ms)))));
}

// Cells 0–100 as buttons; unreachable targets are shown but disabled.
function renderTargetGrid(grid, className, fill) {
  grid.replaceChildren();
  for (let i = 0; i <= 100; i++) {
    const cell = el('button', className);
    cell.type = 'button';
    if (UNREACHABLE.has(i)) { cell.classList.add('unreachable'); cell.disabled = true; }
    else { cell.dataset.action = 'play-target'; cell.dataset.target = i; }
    fill(cell, i);
    grid.append(cell);
  }
}

function renderStats() {
  const recs = Object.values(account.records), times = recs.map((r) => r.bestMs), total = ALL_TARGETS.length;
  $('soSolved').textContent = recs.length;
  $('soTotal').textContent = total;
  $('soAvg').textContent = times.length ? fmt(times.reduce((s, t) => s + t, 0) / times.length) : '—';
  $('soBest').textContent = times.length ? fmt(Math.min(...times)) : '—';
  $('soProgressBar').style.width = Math.round((recs.length / total) * 100) + '%';
  $('soProgressText').textContent = `${recs.length} / ${total}`;
  for (const b of document.querySelectorAll('[data-action="stats-tab"]')) b.setAttribute('aria-pressed', b.dataset.tab === statsTab);
  $('statsGridLabel').textContent = statsTab === 'personal' ? 'Tap a number to play it'
    : bestsFailed ? "Couldn't load times." : 'Global best times — tap to play';
  renderTargetGrid($('statsGrid'), 'sg-cell', (cell, i) => {
    cell.append(el('span', 'sg-num', i));
    if (UNREACHABLE.has(i)) return;
    if (statsTab === 'personal') {
      const rec = account.records[i];
      if (rec) { cell.classList.add('solved'); cell.append(el('span', 'sg-check', '✓'), el('span', 'sg-time', fmt(rec.bestMs))); }
    } else {
      const best = globalBests?.[i];
      if (best) { cell.classList.add('solved'); cell.append(el('span', 'sg-name', best.name), el('span', 'sg-time', fmt(best.ms))); }
    }
  });
}

// ===== OVERLAYS =====
function openOverlay(id) {
  overlayReturn = document.activeElement;
  $(id).classList.add('show');
  $(id).querySelector('.panel-close').focus();
}

// Dismissing an overlay returns focus to its opener; starting a game from one (restore = false) does not.
function closeOverlay(o, restore = true) {
  if (!o.classList.contains('show')) return;
  o.classList.remove('show');
  if (restore && overlayReturn?.isConnected) overlayReturn.focus();
  overlayReturn = null;
  blurWithin(o);
}

function closeOverlays() {
  for (const id of OVERLAYS) closeOverlay($(id), false);
  hideResult();
}

function hideResult() {
  $('resultOverlay').classList.remove('show');
  blurWithin($('resultOverlay'));
  hush();
}

function openPicker() {
  renderTargetGrid($('pickerGrid'), 'pg-cell', (cell, i) => { cell.textContent = i; });
  openOverlay('pickerOverlay');
}

function openStats() {
  if (!account.user) return;
  globalBests = null; bestsFailed = false;
  renderStats();
  openOverlay('statsOverlay');
  api('/api/bests').then(({ bests }) => { globalBests = bests; }, () => { bestsFailed = true; })
    .then(() => { if ($('statsOverlay').classList.contains('show')) renderStats(); });
}

function showResult(won) {
  const o = $('resultOverlay');
  o.classList.remove('glory', 'global');
  o.classList.toggle('miss', !won);
  $('resultBadge').hidden = true;
  $('resultBox').classList.remove('shake');
  $('resultEmoji').className = 'result-emoji';
  $('resultEmoji').textContent = won ? '🎉' : '😬';
  $('resultTitle').textContent = won ? 'You got it!' : 'Not quite!';
  $('resultTitle').className = 'result-title ' + (won ? 'win' : 'lose');
  $('resultDetail').textContent = won ? `Target: ${target}` : `You got ${formatNum(numbers[0])}, needed ${target}`;
  $('resultTime').className = 'result-time';
  $('resultTime').textContent = won ? `⏱ ${fmt(resultMs)}` : '';
  if (!won) $('resultNote').textContent = '';
  o.classList.add('show');
  $('resultPrimary').focus();
  if (won) { countUp(); celebrate(); } else groan();
}

// Plays this game's celebration. A save that earns a bigger one once the result is up plays that one next.
function celebrate() {
  if (cheered === tier) return;
  cheered = tier;
  const t = tier, seq = gameSeq, impact = cheer(t);
  if (t !== 'win') setTimeout(() => { if (seq === gameSeq && isShown('resultOverlay')) stampBadge(t); }, impact);
}

// Lands on the fanfare's big beat: the badge stamps in, the emoji and time flare, the box shakes.
function stampBadge(t) {
  const [emoji, text] = BADGES[t], badge = $('resultBadge');
  badge.textContent = text;
  badge.classList.toggle('global', t === 'global');
  badge.hidden = false;
  $('resultEmoji').textContent = emoji;
  $('resultOverlay').classList.add('glory');
  $('resultOverlay').classList.toggle('global', t === 'global');
  for (const [id, className] of [['resultEmoji', 'bump'], ['resultTime', 'best'], ['resultBox', 'shake']]) {
    const node = $(id);
    node.classList.remove(className);
    void node.offsetWidth; // restarts the animation
    node.classList.add(className);
  }
}

// The time counts up to the result, landing on the saved time if the save answers on the way.
function countUp() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const seq = gameSeq, start = performance.now(), node = $('resultTime');
  requestAnimationFrame(function frame(now) {
    if (seq !== gameSeq) return;
    const k = Math.min(1, Math.max(0, (now - start) / 700));
    node.textContent = `⏱ ${fmt(resultMs * (1 - (1 - k) ** 3))}`;
    if (k < 1) requestAnimationFrame(frame);
  });
}

function renderSound() {
  const on = isSoundOn();
  $('soundBtn').textContent = on ? '🔊' : '🔇';
  $('soundBtn').setAttribute('aria-pressed', on);
}

// ===== CLICKS =====
const actions = {
  'sign-in': () => openAccount(false),
  'register': () => openAccount(true),
  'account-retry': () => openAccount(accountRegister),
  'account-cancel': closeAccount,
  'sign-out': signOut,
  'guest': enterGame,
  'how-to-play': () => openOverlay('howToPlayOverlay'),
  'sound': () => { setSound(!isSoundOn()); renderSound(); },
  'stats': openStats,
  'close-overlay': (b) => closeOverlay(b.closest('.overlay')),
  'start-random': () => playTarget(randomTarget()),
  'choose': openPicker,
  'skip': () => newGame(),
  'play-target': (b) => playTarget(Number(b.dataset.target)),
  'pick-number': (b) => selectNumber(Number(b.dataset.index)),
  'op': (b) => selectOp(b.dataset.op),
  'undo': undoLast,
  'compute': compute,
  'lb-tab': (b) => { lbTab = b.dataset.tab; renderLb(); },
  'stats-tab': (b) => { statsTab = b.dataset.tab; renderStats(); },
  'retry': () => newGame(target),
  'new-random': () => newGame(),
  'result-select': () => { hideResult(); openPicker(); },
};

document.addEventListener('click', (e) => {
  // A pointer click (detail > 0; keyboard clicks have 0) must not leave its button focused, or Enter would press it again.
  if (e.detail > 0 && !e.target.closest('dialog')) document.activeElement?.blur();
  const button = e.target.closest('[data-action]');
  if (button) actions[button.dataset.action]?.(button);
  else if (e.target.classList.contains('overlay')) closeOverlay(e.target); // a click on the backdrop itself
});

$('accountDialog').addEventListener('cancel', (e) => { e.preventDefault(); closeAccount(); });
for (const type of ['keydown', 'keyup']) $('accountDialog').addEventListener(type, (e) => e.stopPropagation());

// ===== KEYBOARD =====
const isShown = (id) => $(id).classList.contains('show');

function gameKeysBlocked() {
  return !$('authOverlay').classList.contains('hidden') || !$('startScreen').classList.contains('hidden')
    || $('gameContent').classList.contains('hidden') || isShown('resultOverlay')
    || OVERLAYS.some(isShown) || $('accountDialog').open;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { const top = OVERLAYS.find(isShown); if (top) closeOverlay($(top)); return; }
  if (gameKeysBlocked()) return;
  // A focused control handles its own Enter/Space; never compute on top of that.
  if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('button, a, input, select, textarea')) return;
  const key = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'z') { e.preventDefault(); undoLast(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^[1-5]$/.test(e.key)) selectNumber(Number(e.key) - 1);
  else if (e.key === '+' || e.key === '=') selectOp('+');
  else if (e.key === '-') selectOp('-');
  else if (e.key === '*' || key === 'x') selectOp('*');
  else if (e.key === '/') { e.preventDefault(); selectOp('/'); }
  else if (e.key === 'Enter') compute();
});

renderAccount();
renderSound();
boot();
