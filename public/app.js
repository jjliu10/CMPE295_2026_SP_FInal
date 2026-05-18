// public/app.js — auth + swipe deck + results, vanilla JS.
// Uses Pointer Events so the same handlers work for touch and mouse.

const TOKEN_KEY = 'swipematch.token';
const USER_KEY  = 'swipematch.user';

const SWIPE_THRESHOLD = 90;   // px past which a horizontal release counts as a vote
const DOWN_THRESHOLD  = 110;  // px of downward drag to open results
const AVATAR_BASE     = 'https://api.dicebear.com/9.x/lorelei/svg?backgroundColor=ffd5dc,ffdfbf,c0aede,d1d4f9,b6e3f4&seed=';

// Inline SVG used when an avatar fails to load (offline, CDN hiccup, etc.) so
// the brief's "no broken images on the target viewport" requirement holds even
// without internet. Single neutral silhouette with the same warm background.
const IMG_FALLBACK = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="#ffd5dc"/>
    <circle cx="50" cy="38" r="18" fill="#ffffff" opacity="0.85"/>
    <path d="M15 95 C20 70 80 70 85 95 Z" fill="#ffffff" opacity="0.85"/>
  </svg>`
);

// Global handler — runs in capture phase because <img> error events don't bubble.
// One handler covers every dynamically-rendered avatar in the deck, the results
// list, and the detail modal without polluting each render site.
window.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG' && t.src !== IMG_FALLBACK) {
    t.src = IMG_FALLBACK;
  }
}, true);

// --- State -----------------------------------------------------------------
let token   = localStorage.getItem(TOKEN_KEY) || null;
let user    = localStorage.getItem(USER_KEY)  || null;
let items   = [];
const itemsById = new Map();             // id → item (for the detail modal)
const voted = new Set();                 // itemIds the user has voted on
const myChoices = new Map();             // itemId → 'yes' | 'no'
const wavedSet = new Set();              // itemIds the user has waved at this session
let lastResults = [];                    // last /api/results rows (for the modal)
let myProfileId = null;                  // id of the viewer's own published profile (or null)
let myUserId    = null;                  // numeric user id (used to ignore self-broadcasts)
let currentSort = 'top';

// --- WebSocket client ------------------------------------------------------
let ws            = null;
let wsReconnectMs = 1000;                // back off up to 30s on repeated failures
let wsReconnectTimer = null;

function connectWS() {
  if (!token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(wsReconnectTimer);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener('open',    () => { wsReconnectMs = 1000; });
  ws.addEventListener('message', (e) => {
    try {
      const { event, payload } = JSON.parse(e.data);
      handleWSEvent(event, payload);
    } catch { /* ignore malformed frames */ }
  });
  ws.addEventListener('close', () => {
    ws = null;
    if (!token) return;            // we logged out, don't reconnect
    wsReconnectTimer = setTimeout(connectWS, wsReconnectMs);
    wsReconnectMs = Math.min(wsReconnectMs * 2, 30_000);
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

function disconnectWS() {
  clearTimeout(wsReconnectTimer);
  if (ws) {
    const w = ws; ws = null;
    try { w.close(); } catch {}
  }
}

function handleWSEvent(event, payload) {
  switch (event) {
    case 'profile:updated': onRemoteProfileUpdated(payload.item); break;
    case 'profile:deleted': onRemoteProfileDeleted(payload.id);   break;
    case 'wave':            onIncomingWave(payload);              break;
  }
}
let searchQuery = '';
let authMode = 'login';   // 'login' | 'register'

// --- DOM -------------------------------------------------------------------
const authView    = document.getElementById('auth-view');
const mainApp     = document.getElementById('main-app');
const authForm    = document.getElementById('auth-form');
const authError   = document.getElementById('auth-error');
const authSubmit  = document.getElementById('auth-submit');
const userNameEl  = document.getElementById('user-name');
const userAvatar  = document.getElementById('user-avatar');
const deckEl      = document.getElementById('deck');
const progressEl  = document.getElementById('progress');
const emptyEl     = document.getElementById('empty');
const resultsEl   = document.getElementById('results');
const statsEl     = document.getElementById('stats');

// --- API helper ------------------------------------------------------------
async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && token) {
    // Token was rejected — bounce back to the auth screen.
    clearAuth();
    stopPolling();
    disconnectWS();
    showAuth();
    throw new Error('session expired');
  }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

// --- Auth flow -------------------------------------------------------------
function showAuth() {
  authView.classList.remove('hidden');
  mainApp.classList.add('hidden');
  setAuthMode('login');
  authError.textContent = '';
  document.getElementById('auth-username').focus();
}

function showApp() {
  authView.classList.add('hidden');
  mainApp.classList.remove('hidden');
  userNameEl.textContent = '@' + user;
  setUserAvatar(null);
  startPolling();
}

// Topbar avatar follows the user's published profile picture when they have one,
// and falls back to a username-seeded default otherwise.
function setUserAvatar(profile) {
  userAvatar.src = profile && profile.imageUrl
    ? profile.imageUrl
    : AVATAR_BASE + encodeURIComponent(user || '');
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.authTab === mode)
  );
  authSubmit.textContent = mode === 'login' ? 'Log in' : 'Create account';
  document.getElementById('auth-password').autocomplete =
    mode === 'login' ? 'current-password' : 'new-password';
}

function saveAuth(t, u) {
  token = t; user = u;
  localStorage.setItem(TOKEN_KEY, t);
  localStorage.setItem(USER_KEY,  u);
}

function clearAuth() {
  token = null; user = null;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  voted.clear();
  myChoices.clear();
  wavedSet.clear();
  itemsById.clear();
  items = [];
  lastResults = [];
  myProfileId = null;
}

document.querySelectorAll('.auth-tab').forEach(t =>
  t.addEventListener('click', () => {
    setAuthMode(t.dataset.authTab);
    authError.textContent = '';
  })
);

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.textContent = '';
  authSubmit.disabled = true;
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const wasRegistering = authMode === 'register';
  try {
    const r = await api('POST', `/api/${authMode}`, { username, password });
    saveAuth(r.token, r.username);
    showApp();
    await bootstrapApp();
    // First-time users are nudged into the profile editor immediately so they
    // join the deck right away. They can still close it without saving.
    if (wasRegistering) openProfileEditor({ welcome: true });
  } catch (err) {
    authError.textContent = err.message || 'Something went wrong.';
  } finally {
    authSubmit.disabled = false;
  }
});

async function logout() {
  try { await api('POST', '/api/logout'); } catch {}
  clearAuth();
  stopPolling();
  disconnectWS();
  // Reset the UI to its initial state.
  deckEl.innerHTML = '';
  resultsEl.innerHTML = '';
  showView('deck');
  showAuth();
}

// --- View routing ----------------------------------------------------------
function showView(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === name + '-view'));
  if (name === 'results') loadResults();
}

document.querySelectorAll('.tab').forEach(t =>
  t.addEventListener('click', () => showView(t.dataset.view))
);

document.querySelectorAll('.chip').forEach(c =>
  c.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach(x => x.classList.remove('active'));
    c.classList.add('active');
    currentSort = c.dataset.sort;
    loadResults();
  })
);

document.querySelectorAll('[data-action]').forEach(b =>
  b.addEventListener('click', () => {
    switch (b.dataset.action) {
      case 'vote-yes':     swipeTop('yes'); break;
      case 'vote-no':      swipeTop('no');  break;
      case 'undo':         undo();          break;
      case 'go-results':   showView('results'); break;
      case 'logout':       logout();        break;
      case 'edit-profile': openProfileEditor(); break;
    }
  })
);

// --- Boot ------------------------------------------------------------------
async function boot() {
  if (!token) { showAuth(); return; }
  // Confirm the saved token is still valid.
  try {
    const me = await api('GET', '/api/me');
    user = me.username;
    localStorage.setItem(USER_KEY, user);
    showApp();
    await bootstrapApp();
  } catch {
    showAuth();
  }
}

async function bootstrapApp() {
  voted.clear(); myChoices.clear(); itemsById.clear();
  try {
    const [itemsRes, myRes, profileRes] = await Promise.all([
      api('GET', '/api/items'),
      api('GET', '/api/my-votes'),
      api('GET', '/api/profile').catch(() => ({ profile: null }))
    ]);
    items = itemsRes.items || [];
    items.forEach(it => itemsById.set(it.id, it));
    (myRes.votes || []).forEach(v => { voted.add(v.itemId); myChoices.set(v.itemId, v.choice); });
    myProfileId = profileRes.profile ? profileRes.profile.id : null;
    setUserAvatar(profileRes.profile);
    renderDeck();
    // Open the live channel once we have a valid session — it auto-reconnects
    // on transient failures and is a no-op when already connected.
    connectWS();
  } catch (e) {
    console.error(e);
    progressEl.textContent = 'Could not load. Try again.';
  }
}

// --- Deck rendering --------------------------------------------------------
const remaining = () => items.filter(it => !voted.has(it.id));

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function createCard(item) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.itemId = item.id;
  el.innerHTML = `
    <div class="badge yes">YES</div>
    <div class="badge no">NO</div>
    <div class="img-wrap"><img src="${item.imageUrl}" alt="" draggable="false"></div>
    <div class="info">
      <h2>${escapeHtml(item.name)}</h2>
      <p>${escapeHtml(item.description || '')}</p>
    </div>`;
  return el;
}

function renderDeck() {
  deckEl.innerHTML = '';
  const rem = remaining();
  updateProgress();
  if (rem.length === 0) { emptyEl.classList.remove('hidden'); return; }
  emptyEl.classList.add('hidden');

  // Render up to 2 cards: bottom card first so the top card stacks on top.
  const toRender = rem.slice(0, 2);
  for (let i = toRender.length - 1; i >= 0; i--) {
    deckEl.appendChild(createCard(toRender[i]));
  }
  attachSwipe(deckEl.lastElementChild);
}

function updateProgress() {
  progressEl.textContent = `${voted.size} / ${items.length} voted`;
}

// --- Swipe gesture ---------------------------------------------------------
function attachSwipe(card) {
  if (!card || card.dataset.bound) return;
  card.dataset.bound = '1';
  // Mark when this card became the top, so we can report decision time on commit.
  card.dataset.shownAt = String(performance.now());

  let startX = 0, startY = 0, dx = 0, dy = 0;
  let dragging = false;
  let lock = null;   // 'h' | 'v' | null

  card.addEventListener('pointerdown', (e) => {
    if (card.dataset.gone) return;
    dragging = true; lock = null; dx = 0; dy = 0;
    startX = e.clientX; startY = e.clientY;
    card.classList.add('dragging');
    card.setPointerCapture(e.pointerId);
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    if (!lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      lock = (Math.abs(dy) > Math.abs(dx) && dy > 0) ? 'v' : 'h';
    }
    if (lock === 'h') {
      card.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx / 20}deg)`;
      card.dataset.dir = dx > 30 ? 'yes' : dx < -30 ? 'no' : '';
    } else if (lock === 'v') {
      card.style.transform = `translate(0, ${Math.max(0, dy)}px)`;
    }
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('dragging');
    if (lock === 'h' && Math.abs(dx) > SWIPE_THRESHOLD) {
      commit(card, dx > 0 ? 'yes' : 'no');
    } else if (lock === 'v' && dy > DOWN_THRESHOLD) {
      card.style.transform = ''; card.dataset.dir = '';
      showView('results');
    } else {
      card.style.transform = ''; card.dataset.dir = '';
    }
  };
  card.addEventListener('pointerup',     release);
  card.addEventListener('pointercancel', release);
}

function commit(card, choice) {
  if (card.dataset.gone) return;
  card.dataset.gone = '1';
  card.dataset.dir = choice;
  const w = window.innerWidth;
  card.style.transform = `translate(${choice === 'yes' ? w : -w}px, 60px) rotate(${choice === 'yes' ? 30 : -30}deg)`;
  card.style.opacity = '0';

  const itemId = card.dataset.itemId;
  voted.add(itemId);
  myChoices.set(itemId, choice);
  updateProgress();

  const decisionMs = card.dataset.shownAt
    ? Math.round(performance.now() - parseFloat(card.dataset.shownAt))
    : null;

  api('POST', '/api/vote', { itemId, choice, decisionMs }).catch(err => {
    if (err.message !== 'session expired') console.error('vote failed', err);
  });

  setTimeout(() => { card.remove(); refillDeck(); }, 320);
}

function refillDeck() {
  const rem = remaining();
  if (rem.length === 0) { emptyEl.classList.remove('hidden'); return; }
  const inDeck = new Set([...deckEl.children].map(c => c.dataset.itemId));
  const desired = Math.min(2, rem.length);
  for (const it of rem) {
    if (deckEl.children.length >= desired) break;
    if (inDeck.has(it.id)) continue;
    deckEl.insertBefore(createCard(it), deckEl.firstChild);
  }
  attachSwipe(deckEl.lastElementChild);
}

function swipeTop(choice) {
  const top = deckEl.lastElementChild;
  if (!top || top.dataset.gone) return;
  commit(top, choice);
}

// --- Undo ------------------------------------------------------------------
async function undo() {
  try {
    const r = await api('POST', '/api/undo');
    if (r.ok && r.removed) {
      voted.delete(r.removed.itemId);
      myChoices.delete(r.removed.itemId);
      renderDeck();
    }
  } catch (e) {
    if (e.message !== 'session expired') console.error('undo failed', e);
  }
}

// --- Results ---------------------------------------------------------------
async function loadResults() {
  try {
    const [data, stats] = await Promise.all([
      api('GET', `/api/results?sort=${currentSort}`),
      api('GET', '/api/stats')
    ]);
    const bits = [
      `${stats.totalVotes} swipes`,
      `${stats.totalSessions ?? stats.totalUsers} sessions`,
      `${stats.totalUsers} users`,
      `${stats.totalItems} items`
    ];
    if (stats.avgDecisionMs != null) bits.push(`${(stats.avgDecisionMs / 1000).toFixed(1)}s avg decision`);
    statsEl.textContent = bits.join(' · ');
    lastResults = data.results || [];
    renderResultsList();
  } catch (e) {
    if (e.message !== 'session expired') statsEl.textContent = 'Could not load results.';
  }
}

function renderResultsList() {
  if (!lastResults.length) {
    resultsEl.innerHTML = `<li class="empty-row">${
      currentSort === 'matches'
        ? "Swipe yes on a few profiles to find your matches."
        : "No votes yet — be the first."
    }</li>`;
    return;
  }
  const q = searchQuery.trim().toLowerCase();
  const rows = q ? lastResults.filter(r => r.name.toLowerCase().includes(q)) : lastResults;
  if (!rows.length) {
    resultsEl.innerHTML = `<li class="empty-row">No matches for "${escapeHtml(searchQuery.trim())}".</li>`;
    return;
  }
  resultsEl.innerHTML = rows.map((r, i) => `
    <li data-item-id="${r.id}" tabindex="0">
      <div class="rank">#${i + 1}</div>
      <div class="thumb"><img src="${r.imageUrl}" alt=""></div>
      <div class="meta">
        <h3>${escapeHtml(r.name)}${r.mine ? '<span class="mine-badge">YOU</span>' : ''}</h3>
        <div class="bar"><div class="bar-fill" style="width:${r.yesPct}%"></div></div>
      </div>
      <div class="pct">${r.yesPct}%<small>${r.yes}y · ${r.no}n</small></div>
    </li>`).join('');
}

const searchInput = document.getElementById('results-search');
searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderResultsList();
});

// --- Live polling ---------------------------------------------------------
// Refresh aggregate counts every 30s while the user is on the results tab
// and the browser tab is visible. Scroll position is preserved across the
// re-render so a fresh batch of votes doesn't yank the list under the user.
const POLL_MS = 30_000;
let pollTimer = null;
const resultsView = document.getElementById('results-view');

async function pollResultsTick() {
  if (!token) return;
  if (document.hidden) return;
  if (!resultsView.classList.contains('active')) return;
  const scrollY = resultsView.scrollTop;
  await loadResults();
  resultsView.scrollTop = scrollY;
}

function startPolling() { if (!pollTimer) pollTimer = setInterval(pollResultsTick, POLL_MS); }
function stopPolling()  { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// Fire an immediate refresh when the user comes back to the tab.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollResultsTick();
});

// --- Profile detail modal -------------------------------------------------
const modal           = document.getElementById('profile-modal');
const modalAvatar     = document.getElementById('profile-avatar');
const modalName       = document.getElementById('profile-name');
const modalDesc       = document.getElementById('profile-desc');
const modalPct        = document.getElementById('profile-pct');
const modalYes        = document.getElementById('profile-yes');
const modalNo         = document.getElementById('profile-no');
const modalYourVote   = document.getElementById('profile-your-vote');
const modalWaveBtn    = document.getElementById('profile-wave-btn');
const modalWaveOK     = document.getElementById('profile-wave-confirm');
let modalCurrentId    = null;

function openProfile(itemId) {
  // The viewer's own profile is intentionally excluded from /api/items (so they
  // can't vote on themselves), which means itemsById won't have it. /api/results
  // includes every item, so we fall back to the last results row.
  const item   = itemsById.get(itemId);
  const result = lastResults.find(r => r.id === itemId);
  const data   = item || result;
  if (!data) return;
  modalCurrentId = itemId;

  modalAvatar.src       = data.imageUrl;
  modalName.textContent = data.name;
  modalDesc.textContent = (item && item.description) || (result && result.description) || '';

  const pct   = result ? result.yesPct : 0;
  const yes   = result ? result.yes    : 0;
  const no    = result ? result.no     : 0;
  modalPct.textContent = pct + '%';
  modalYes.textContent = yes;
  modalNo.textContent  = no;

  const isSelf = itemId === myProfileId;
  const choice = myChoices.get(itemId);
  modalYourVote.innerHTML = isSelf
    ? `This is your profile — others are voting on you.`
    : choice
      ? `Your vote: <span class="pill ${choice}">${choice.toUpperCase()}</span>`
      : `You haven't voted on this one yet.`;

  // Hide the wave affordance on the viewer's own profile — waving at yourself
  // is nonsense.
  modalWaveBtn.hidden = isSelf;
  modalWaveOK.classList.add('hidden');
  if (!isSelf) {
    if (wavedSet.has(itemId)) {
      modalWaveBtn.disabled    = true;
      modalWaveBtn.textContent = 'Wave sent';
      modalWaveOK.classList.remove('hidden');
    } else {
      modalWaveBtn.disabled    = false;
      modalWaveBtn.textContent = 'Send a wave 👋';
    }
  }

  modal.classList.remove('hidden');
}

function closeProfile() {
  modal.classList.add('hidden');
  modalCurrentId = null;
}

resultsEl.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-item-id]');
  if (li) openProfile(li.dataset.itemId);
});

modal.addEventListener('click', (e) => {
  if (e.target.dataset.modalClose !== undefined) closeProfile();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeProfile();
});

modalWaveBtn.addEventListener('click', async () => {
  if (!modalCurrentId || wavedSet.has(modalCurrentId)) return;
  // Optimistic UI: update locally before the server confirms, then roll back
  // if the POST is rejected (e.g. recipient was deleted between renders).
  const itemId = modalCurrentId;
  wavedSet.add(itemId);
  modalWaveBtn.disabled    = true;
  modalWaveBtn.textContent = 'Wave sent';
  modalWaveOK.classList.remove('hidden');
  try {
    await api('POST', '/api/wave', { itemId });
  } catch (err) {
    wavedSet.delete(itemId);
    if (modalCurrentId === itemId) {
      modalWaveBtn.disabled    = false;
      modalWaveBtn.textContent = 'Send a wave 👋';
      modalWaveOK.classList.add('hidden');
    }
    if (err.message !== 'session expired') console.error('wave failed', err);
  }
});

// --- Live (WebSocket) event handlers ---------------------------------------
const isResultsVisible = () => document.getElementById('results-view').classList.contains('active');

function onRemoteProfileUpdated(item) {
  if (!item || !item.id) return;
  // The server already excludes the originating user, so any item we see here
  // belongs to somebody else and should appear in our deck.

  // Patch deck-side caches.
  itemsById.set(item.id, item);
  const dIdx = items.findIndex(it => it.id === item.id);
  if (dIdx >= 0) items[dIdx] = item;
  else           items.push(item);

  // Patch the results-side cache too. The aggregate counts on the row don't
  // change (a profile edit doesn't move yes/no), but name / avatar / bio can.
  const rIdx = lastResults.findIndex(r => r.id === item.id);
  if (rIdx >= 0) {
    lastResults[rIdx] = {
      ...lastResults[rIdx],
      name:        item.name,
      imageUrl:    item.imageUrl,
      description: item.description || ''
    };
  }

  // Re-render whichever view the user is looking at right now.
  if (isResultsVisible()) renderResultsList();
  else if (!deckEl.querySelector('.card.dragging')) renderDeck();

  // And refresh the detail modal if it's open on this card.
  if (!modal.classList.contains('hidden') && modalCurrentId === item.id) openProfile(item.id);
}

function onRemoteProfileDeleted(id) {
  if (!id) return;
  itemsById.delete(id);
  items       = items.filter(it => it.id !== id);
  lastResults = lastResults.filter(r => r.id !== id);
  voted.delete(id);
  myChoices.delete(id);
  if (isResultsVisible()) renderResultsList();
  else if (!deckEl.querySelector('.card.dragging')) renderDeck();
  if (!modal.classList.contains('hidden') && modalCurrentId === id) closeProfile();
}

function onIncomingWave({ fromUsername, itemName }) {
  showToast(`👋 ${fromUsername} waved at ${itemName ? `your card "${itemName}"` : 'you'}!`);
}

// Stacking toast container (created on first use so it can't fight the auth view).
let toastStack = null;
function showToast(message, ttlMs = 5000) {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.className = 'toast-stack';
    document.body.appendChild(toastStack);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toastStack.appendChild(el);
  // Trigger the slide-in transition on the next frame.
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, ttlMs);
}

// --- Profile editor (the user's own card) ---------------------------------
const editModal     = document.getElementById('profile-edit-modal');
const avatarPicker  = document.getElementById('avatar-picker');
const shuffleBtn    = document.getElementById('avatar-shuffle');
const nameInput     = document.getElementById('profile-edit-name');
const descInput     = document.getElementById('profile-edit-desc');
const descCount     = document.getElementById('profile-edit-desc-count');
const editError     = document.getElementById('profile-edit-error');
const editSaveBtn   = document.getElementById('profile-edit-save');
const editDeleteBtn = document.getElementById('profile-edit-delete');

const AVATAR_BG = 'ffd5dc,ffdfbf,c0aede,d1d4f9,b6e3f4,c0e5e3,fde68a,fecaca';
const AVATAR_STYLE = 'lorelei';
let avatarOptions = [];
let selectedAvatar = null;
let hasPublishedProfile = false;

function randomSeed() {
  return Math.random().toString(36).slice(2, 10);
}
function avatarUrl(seed) {
  return `https://api.dicebear.com/9.x/${AVATAR_STYLE}/svg?seed=${encodeURIComponent(seed)}&backgroundColor=${AVATAR_BG}`;
}
function renderAvatarOptions() {
  avatarPicker.innerHTML = avatarOptions.map(url => `
    <button type="button" class="opt${url === selectedAvatar ? ' selected' : ''}" data-url="${url}" role="radio" aria-checked="${url === selectedAvatar}">
      <img src="${url}" alt="">
    </button>`).join('');
}
function shuffleAvatars(keepSelected = true) {
  avatarOptions = Array.from({ length: 8 }, () => avatarUrl(randomSeed()));
  if (keepSelected && selectedAvatar) avatarOptions[0] = selectedAvatar;
  if (!selectedAvatar) selectedAvatar = avatarOptions[0];
  renderAvatarOptions();
}

avatarPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('.opt');
  if (!btn) return;
  selectedAvatar = btn.dataset.url;
  renderAvatarOptions();
});
shuffleBtn.addEventListener('click', () => shuffleAvatars(false));
descInput.addEventListener('input', () => { descCount.textContent = `${descInput.value.length}/240`; });
editModal.addEventListener('click', (e) => {
  if (e.target.dataset.modalClose !== undefined) editModal.classList.add('hidden');
});

async function openProfileEditor({ welcome = false } = {}) {
  editError.textContent = '';
  let profile = null;
  try {
    const r = await api('GET', '/api/profile');
    profile = r.profile;
  } catch { /* fall through with empty defaults */ }

  if (profile) {
    hasPublishedProfile = true;
    nameInput.value     = profile.name;
    descInput.value     = profile.description || '';
    selectedAvatar      = profile.imageUrl;
    editDeleteBtn.hidden = false;
  } else {
    hasPublishedProfile = false;
    // First-time setup: prefill the display name with their username so they
    // only have to add an age / tweak it instead of typing from scratch.
    nameInput.value     = welcome && user ? user : '';
    descInput.value     = '';
    selectedAvatar      = null;
    editDeleteBtn.hidden = true;
  }

  const titleEl = document.getElementById('profile-edit-title');
  const subEl   = editModal.querySelector('.modal-sub');
  if (welcome && !profile) {
    titleEl.textContent = `Welcome, ${user || ''} — set up your profile`;
    subEl.textContent   = "Pick an avatar, write a quick blurb, and you're in the deck. You can also skip and add it later from the menu.";
  } else {
    titleEl.textContent = 'Your profile';
    subEl.textContent   = "Add yourself to the deck. Other voters will see this card — you won't see your own.";
  }

  descCount.textContent = `${descInput.value.length}/240`;
  shuffleAvatars(true);
  editModal.classList.remove('hidden');
}

editSaveBtn.addEventListener('click', async () => {
  editError.textContent = '';
  if (!selectedAvatar) { editError.textContent = 'Pick an avatar first.'; return; }
  const name = nameInput.value.trim();
  if (!name) { editError.textContent = 'Display name is required.'; return; }
  editSaveBtn.disabled = true;
  try {
    await api('POST', '/api/profile', { name, description: descInput.value.trim(), imageUrl: selectedAvatar });
    editModal.classList.add('hidden');
    // Reload deck so the user sees the latest item list (theirs is excluded).
    await bootstrapApp();
  } catch (err) {
    editError.textContent = err.message || 'Could not save.';
  } finally {
    editSaveBtn.disabled = false;
  }
});

editDeleteBtn.addEventListener('click', async () => {
  if (!confirm('Remove your profile from the deck? Votes others cast on it will also be deleted.')) return;
  editDeleteBtn.disabled = true;
  try {
    await api('DELETE', '/api/profile');
    editModal.classList.add('hidden');
    await bootstrapApp();
  } catch (err) {
    editError.textContent = err.message || 'Could not remove.';
  } finally {
    editDeleteBtn.disabled = false;
  }
});

boot();
