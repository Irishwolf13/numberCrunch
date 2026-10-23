// Number Crunch client. All behaviour lives here: the page's CSP forbids inline scripts and handlers.
import { START_NUMBERS, UNREACHABLE, ALL_TARGETS, applyStep, isTargetHit } from '/game-rules.js';
import { openAccountWindow } from '/vendor/bcm-auth-browser.js';

const SSO_FLAG = 'blackcat.sso.attempted.v1';
const OP_SYMBOLS = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const OVERLAYS = ['howToPlayOverlay', 'statsOverlay', 'pickerOverlay']; // topmost first
const RANKS = ['gold', 'silver', 'bronze', '', ''];
const $ = (id) => document.getElementById(id);

// ===== STATE =====
const account = { user: null, accountUrl: null, records: {} };
let target = null, numbers = [], selectedNums = [], selectedOp = null;
let moves = [];             // [{numbers before the step, step: {a, b, op}}], the undo stack and the solution
let round = null;           // {target, roundId: Promise} for a signed-in player's server round
let gameSeq = 0, lbSeq = 0; // drop async results that belong to an earlier game or leaderboard load
let timerStart = 0, timerInterval = null;
let lbTab = 'global', lb = { state: 'loading', entries: [] };
let statsTab = 'personal', globalBests = null, bestsFailed = false;
let overlayReturn = null;
let accountCleanup = () => {}, accountRegister = false;

const fmt = (ms) => (ms / 1000).toFixed(1) + 's';
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
  try { me = await api('/api/me'); } catch { /* shown below */ }
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
async function api(path, body) {
  const res = await fetch(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed with ${res.status}`);
  return res.json();
}

function startRound(t) {
  const roundId = api('/api/rounds', { target: t }).then((r) => r.roundId);
  roundId.catch(() => {}); // a failed start is reported when the round finishes
  return roundId;
}

async function saveSolve(r, steps, clientMs) {
  const seq = gameSeq;
  const say = (text, best = false) => {
    if (seq !== gameSeq) return;
    $('resultNote').textContent = text;
    $('resultNote').classList.toggle('best', best);
  };
  if (!account.user) return say('Sign in to save your times.');
  if (!r) return say('Times save from your next round.');
  say('Saving your time…');
  try {
    const roundId = await r.roundId;
    const res = await api(`/api/rounds/${encodeURIComponent(roundId)}/finish`, { steps, clientMs });
    account.records[r.target] = { bestMs: res.bestMs, solveCount: res.solveCount };
    say(res.personalBest ? 'New personal best!' : `Saved. Your best: ${fmt(res.bestMs)}`, res.personalBest === true);
  } catch {
    say("Couldn't save this time.");
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
  const won = isTargetHit(numbers[0], target), seq = gameSeq;
  if (won) saveSolve(round, moves.map((m) => m.step), ms);
  setTimeout(() => { if (seq === gameSeq) showResult(won, ms); }, 400);
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

function showResult(won, ms) {
  $('resultEmoji').textContent = won ? '🎉' : '😬';
  $('resultTitle').textContent = won ? 'You got it!' : 'Not quite!';
  $('resultTitle').className = 'result-title ' + (won ? 'win' : 'lose');
  $('resultDetail').textContent = won ? `Target: ${target}` : `You got ${formatNum(numbers[0])}, needed ${target}`;
  $('resultTime').textContent = won ? `⏱ ${fmt(ms)}` : '';
  if (!won) $('resultNote').textContent = '';
  $('resultOverlay').classList.add('show');
  $('resultPrimary').focus();
  if (won) fanfare();
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

// ===== CONFETTI =====
const canvas = $('confetti');
const ctx = canvas.getContext('2d');
let particles = [], animFrame;
function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
resizeCanvas(); window.addEventListener('resize', resizeCanvas);

function fanfare() {
  const colors = ['#00e6a0','#4ade80','#ffd700','#f97316','#ff4466','#a855f7','#4488ff','#ec4899','#fff'];
  const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  for (let i = 0; i < 180; i++) {
    const a = Math.random() * Math.PI * 2, sp = 4 + Math.random() * 12;
    particles.push({ x: cx, y: cy, vx: Math.cos(a)*sp*(0.5+Math.random()), vy: Math.sin(a)*sp*(0.5+Math.random())-4,
      color: colors[Math.floor(Math.random()*colors.length)], size: 4+Math.random()*7,
      rotation: Math.random()*360, rotSpeed: (Math.random()-0.5)*14, life: 1,
      decay: 0.006+Math.random()*0.01, shape: Math.random()>0.5?'rect':'circle' });
  }
  if (!animFrame) animateConfetti();
}

function animateConfetti() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = particles.length-1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.16; p.vx *= 0.99;
    p.rotation += p.rotSpeed; p.life -= p.decay;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rotation*Math.PI/180);
    ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
    if (p.shape === 'rect') ctx.fillRect(-p.size/2, -p.size/4, p.size, p.size/2);
    else { ctx.beginPath(); ctx.arc(0, 0, p.size/2, 0, Math.PI*2); ctx.fill(); }
    ctx.restore();
  }
  if (particles.length > 0) animFrame = requestAnimationFrame(animateConfetti);
  else animFrame = null;
}

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
boot();
