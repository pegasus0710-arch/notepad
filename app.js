import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, doc, getDocs, addDoc, deleteDoc, setDoc, serverTimestamp, writeBatch }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// ══════════════════════════════════════════════
// Firebase 설정 (본인 설정으로 교체)
// ══════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);
const auth  = getAuth(fbApp);
const provider = new GoogleAuthProvider();

// ══════════════════════════════════════════════
// 상태
// ══════════════════════════════════════════════
let currentUser = null;
let notes = [];        // active notes
let trashedNotes = []; // deleted notes
let categories = [];   // [{id, name, colorIdx}]
let settings = { trashPeriod: 30 };

let currentNav = 'all';      // 'all' | 'trash' | 'cat:{id}'
let currentView = 'grid';    // 'grid' | 'list' | 'magazine'
let editingDocId = null;
let editTags = [];
let editLinks = []; // [{label, url}]

// ══════════════════════════════════════════════
// Firestore 경로
// ══════════════════════════════════════════════
const notesCol  = () => collection(db, 'users', currentUser.uid, 'notes');
const catsCol   = () => collection(db, 'users', currentUser.uid, 'categories');
const settDoc   = () => doc(db, 'users', currentUser.uid, 'settings', 'main');

// ══════════════════════════════════════════════
// 로드
// ══════════════════════════════════════════════
async function loadAll() {
  setSyncStatus('loading');
  try {
    // Notes
    const nSnap = await getDocs(notesCol());
    const allNotes = nSnap.docs.map(d => ({
      ...d.data(), _docId: d.id,
      createdAt: d.data().createdAt?.toDate?.() || new Date(d.data().createdAt || Date.now()),
      updatedAt: d.data().updatedAt?.toDate?.() || new Date(d.data().updatedAt || Date.now()),
      deletedAt: d.data().deletedAt?.toDate?.() || (d.data().deletedAt ? new Date(d.data().deletedAt) : null),
    }));
    notes = allNotes.filter(n => !n.deleted);
    trashedNotes = allNotes.filter(n => n.deleted);

    // Categories
    const cSnap = await getDocs(catsCol());
    categories = cSnap.docs.map(d => ({ ...d.data(), _docId: d.id }));

    // Settings
    try {
      const sSnap = await getDocs(collection(db, 'users', currentUser.uid, 'settings'));
      sSnap.docs.forEach(d => { if (d.id === 'main') settings = { ...settings, ...d.data() }; });
      document.getElementById('trash-period-select').value = String(settings.trashPeriod ?? 30);
    } catch {}

    // Auto-delete expired trash
    await autoDeleteExpiredTrash();

    setSyncStatus('ok');
  } catch(e) {
    console.error(e);
    setSyncStatus('error');
  }
}

// ══════════════════════════════════════════════
// 카테고리 CRUD
// ══════════════════════════════════════════════
const CAT_COLORS = 8; // 0~7

function getCatById(id) {
  return categories.find(c => c._docId === id);
}
function getCatColorIdx(catId) {
  const idx = categories.findIndex(c => c._docId === catId);
  return idx >= 0 ? idx % CAT_COLORS : -1;
}

window.addCategory = async function() {
  const input = document.getElementById('new-cat-input');
  const name = input.value.trim();
  if (!name) return;
  if (categories.find(c => c.name === name)) { showToast('이미 있는 카테고리입니다.', 'error'); return; }
  try {
    const ref = await addDoc(catsCol(), { name });
    categories.push({ name, _docId: ref.id });
    input.value = '';
    renderSidebar();
    renderCatSelect();
    showToast(`'${name}' 카테고리 추가됨`, 'success');
  } catch(e) { showToast('추가 실패: ' + e.message, 'error'); }
};

window.deleteCategory = async function(catId) {
  const cat = getCatById(catId);
  if (!cat) return;
  if (!confirm(`'${cat.name}' 카테고리를 삭제하시겠습니까?\n해당 카테고리의 메모는 '카테고리없음'으로 변경됩니다.`)) return;
  try {
    // Batch: delete cat + update notes
    const batch = writeBatch(db);
    batch.delete(doc(catsCol(), catId));
    const affected = notes.filter(n => n.category === catId);
    affected.forEach(n => {
      batch.set(doc(notesCol(), n._docId), { category: '', updatedAt: serverTimestamp() }, { merge: true });
      n.category = '';
    });
    await batch.commit();
    categories = categories.filter(c => c._docId !== catId);
    if (currentNav === `cat:${catId}`) selectNav('all');
    renderAll();
    showToast(`'${cat.name}' 카테고리 삭제됨`, 'success');
  } catch(e) { showToast('삭제 실패: ' + e.message, 'error'); }
};

// ══════════════════════════════════════════════
// 노트 CRUD
// ══════════════════════════════════════════════
async function addNote(data) {
  const payload = { ...data, deleted: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const ref = await addDoc(notesCol(), payload);
  const now = new Date();
  const note = { ...data, deleted: false, _docId: ref.id, createdAt: now, updatedAt: now, deletedAt: null };
  notes.push(note);
  return note;
}

async function updateNote(docId, data) {
  await setDoc(doc(notesCol(), docId), { ...data, updatedAt: serverTimestamp() }, { merge: true });
  const idx = notes.findIndex(n => n._docId === docId);
  if (idx !== -1) notes[idx] = { ...notes[idx], ...data, updatedAt: new Date() };
}

// 휴지통으로 이동 (soft delete)
async function moveToTrash(docId) {
  const now = new Date();
  await setDoc(doc(notesCol(), docId), { deleted: true, deletedAt: serverTimestamp() }, { merge: true });
  const note = notes.find(n => n._docId === docId);
  if (note) {
    note.deleted = true; note.deletedAt = now;
    notes = notes.filter(n => n._docId !== docId);
    trashedNotes.push(note);
  }
}

// 복원
async function restoreNote(docId) {
  await setDoc(doc(notesCol(), docId), { deleted: false, deletedAt: null }, { merge: true });
  const note = trashedNotes.find(n => n._docId === docId);
  if (note) {
    note.deleted = false; note.deletedAt = null;
    trashedNotes = trashedNotes.filter(n => n._docId !== docId);
    notes.push(note);
  }
}

// 완전 삭제
async function permanentDelete(docId) {
  await deleteDoc(doc(notesCol(), docId));
  trashedNotes = trashedNotes.filter(n => n._docId !== docId);
}

// 자동 삭제 (기간 초과)
async function autoDeleteExpiredTrash() {
  const period = settings.trashPeriod ?? 30;
  if (period === 0) return;
  const now = Date.now();
  const expired = trashedNotes.filter(n => {
    if (!n.deletedAt) return false;
    const ms = period * 24 * 60 * 60 * 1000;
    return (now - new Date(n.deletedAt).getTime()) > ms;
  });
  if (!expired.length) return;
  const batch = writeBatch(db);
  expired.forEach(n => batch.delete(doc(notesCol(), n._docId)));
  await batch.commit();
  trashedNotes = trashedNotes.filter(n => !expired.includes(n));
}

// 휴지통 비우기
window.emptyTrash = async function() {
  if (!trashedNotes.length) { showToast('휴지통이 비어있습니다.', 'warning'); return; }
  if (!confirm(`휴지통의 메모 ${trashedNotes.length}개를 영구 삭제하시겠습니까?`)) return;
  try {
    const batch = writeBatch(db);
    trashedNotes.forEach(n => batch.delete(doc(notesCol(), n._docId)));
    await batch.commit();
    trashedNotes = [];
    renderAll();
    showToast('휴지통을 비웠습니다.', 'success');
  } catch(e) { showToast('실패: ' + e.message, 'error'); }
};

// 휴지통 기간 저장
window.saveTrashPeriod = async function() {
  const period = parseInt(document.getElementById('trash-period-select').value);
  settings.trashPeriod = period;
  await setDoc(settDoc(), { trashPeriod: period }, { merge: true });
  showToast('설정이 저장되었습니다.', 'success');
};

// ══════════════════════════════════════════════
// 링크 - 파비콘 URL
// ══════════════════════════════════════════════
function getFaviconUrl(url) {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
  } catch { return ''; }
}
function getDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url.slice(0, 30); }
}

// ══════════════════════════════════════════════
// 태그 자동 추출
// ══════════════════════════════════════════════
function extractTags(text) {
  const tags = (text.match(/#[\w가-힣]+/g) || []).map(t => t.slice(1));
  return [...new Set(tags)];
}

// ══════════════════════════════════════════════
// 필터 & 정렬
// ══════════════════════════════════════════════
function getFilteredSorted() {
  const q = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
  const sort = document.getElementById('sort-select')?.value || 'created_desc';
  const isTrash = currentNav === 'trash';
  let list = isTrash ? [...trashedNotes] : [...notes];

  // 카테고리 필터
  if (!isTrash && currentNav.startsWith('cat:')) {
    const catId = currentNav.slice(4);
    list = list.filter(n => n.category === catId);
  }

  // 검색
  if (q) {
    list = list.filter(n =>
      (n.title||'').toLowerCase().includes(q) ||
      (n.content||'').toLowerCase().includes(q) ||
      (n.tags||[]).some(t => t.toLowerCase().includes(q)) ||
      (getCatById(n.category)?.name||'').toLowerCase().includes(q)
    );
  }

  // 정렬
  const key = sort.startsWith('created') ? 'createdAt' : 'updatedAt';
  const asc = sort.endsWith('asc');
  list.sort((a, b) => {
    const at = new Date(a[key] || 0), bt = new Date(b[key] || 0);
    return asc ? at - bt : bt - at;
  });
  return list;
}

// ══════════════════════════════════════════════
// 렌더링
// ══════════════════════════════════════════════
function renderAll() {
  renderSidebar();
  renderNotes();
  renderStats();
  renderCatSelect();
}

// SIDEBAR
function renderSidebar() {
  // counts
  const allCount = notes.length;
  const trashCount = trashedNotes.length;
  document.getElementById('cnt-all').textContent = allCount;
  const trashCnt = document.getElementById('cnt-trash');
  if (trashCount > 0) { trashCnt.textContent = trashCount; trashCnt.style.display = ''; }
  else trashCnt.style.display = 'none';

  // nav active
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  if (currentNav === 'all') document.getElementById('nav-all').classList.add('active');
  else if (currentNav === 'trash') document.getElementById('nav-trash').classList.add('active');

  // trash panel
  document.getElementById('trash-panel').classList.toggle('hidden', currentNav !== 'trash');

  // cat list
  const catList = document.getElementById('cat-list');
  catList.innerHTML = categories.map((cat, i) => {
    const colorIdx = i % CAT_COLORS;
    const count = notes.filter(n => n.category === cat._docId).length;
    const isActive = currentNav === `cat:${cat._docId}`;
    return `<div class="cat-item${isActive ? ' active' : ''}" onclick="selectNav('cat:${esc(cat._docId)}')">
      <span class="cat-dot cd${colorIdx}"></span>
      <span class="cat-name">${esc(cat.name)}</span>
      <span class="cat-cnt">${count}</span>
      <button class="cat-del-btn" onclick="event.stopPropagation();deleteCategory('${esc(cat._docId)}')" title="삭제">✕</button>
    </div>`;
  }).join('');
}

// NOTES
function renderNotes() {
  const container = document.getElementById('notes-container');
  // update view class
  container.className = `view-${currentView}`;

  const list = getFilteredSorted();
  const isTrash = currentNav === 'trash';

  if (!list.length) {
    const q = (document.getElementById('search-input')?.value || '').trim();
    container.innerHTML = `<div class="notes-empty">
      <div class="notes-empty-icon">${isTrash ? '🗑️' : q ? '🔍' : '📭'}</div>
      <p>${isTrash ? '휴지통이 비어있습니다.' : q ? `'${esc(q)}' 검색 결과 없음` : '메모가 없습니다. 새 메모를 작성해보세요!'}</p>
    </div>`;
    return;
  }

  if (currentView === 'grid') container.innerHTML = list.map(n => renderCardView(n, isTrash)).join('');
  else if (currentView === 'list') container.innerHTML = list.map(n => renderListView(n, isTrash)).join('');
  else container.innerHTML = list.map(n => renderMagazineView(n, isTrash)).join('');
}

// STATS
function renderStats() {
  const list = getFilteredSorted();
  const bar = document.getElementById('stats-bar');
  bar.innerHTML = `<span>표시 <strong>${list.length}</strong>개</span>
    <span>전체 <strong>${notes.length}</strong>개</span>
    <span>휴지통 <strong>${trashedNotes.length}</strong>개</span>`;
}

// CAT SELECT in modal
function renderCatSelect() {
  const sel = document.getElementById('note-cat-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">카테고리없음</option>` +
    categories.map(c => `<option value="${esc(c._docId)}">${esc(c.name)}</option>`).join('');
  if (prev) sel.value = prev;
}

// PAGE TITLE
function renderPageTitle() {
  const el = document.getElementById('page-title');
  if (currentNav === 'all') el.textContent = '📝 전체 메모';
  else if (currentNav === 'trash') el.textContent = '🗑️ 휴지통';
  else {
    const catId = currentNav.slice(4);
    const cat = getCatById(catId);
    el.textContent = cat ? `🗂️ ${cat.name}` : '📝 메모';
  }
}

// ─── CARD VIEW ───
function renderCardView(n, isTrash) {
  const catIdx = getCatColorIdx(n.category);
  const ccClass = catIdx >= 0 ? `cc${catIdx}` : 'cc-none';
  const catName = getCatById(n.category)?.name || '카테고리없음';
  const cbClass = catIdx >= 0 ? `cb${catIdx}` : 'cb-none';
  return `<div class="note-card ${ccClass}" onclick="openDetail('${esc(n._docId)}',${isTrash})">
    <div class="note-head">
      <div class="note-title">${esc(n.title||'제목 없음')}</div>
      <span class="cat-badge ${cbClass}">${esc(catName)}</span>
    </div>
    ${n.content ? `<div class="note-body">${esc(n.content)}</div>` : ''}
    ${renderLinkChips(n.links)}
    ${renderTagChips(n.tags)}
    <div class="note-footer">
      <div class="note-dates">
        <span>📅 ${fmt(n.createdAt)}</span>
        ${n.updatedAt && fmt(n.updatedAt) !== fmt(n.createdAt) ? `<span>✏️ ${fmt(n.updatedAt)}</span>` : ''}
        ${isTrash && n.deletedAt ? `<span style="color:var(--red)">🗑 ${fmt(n.deletedAt)}</span>` : ''}
      </div>
      <div class="note-actions">
        ${isTrash
          ? `<button class="nact green" onclick="event.stopPropagation();doRestore('${esc(n._docId)}')">복원</button>
             <button class="nact del" onclick="event.stopPropagation();doPermDelete('${esc(n._docId)}')">완전삭제</button>`
          : `<button class="nact" onclick="event.stopPropagation();editNote('${esc(n._docId)}')">수정</button>
             <button class="nact del" onclick="event.stopPropagation();doTrash('${esc(n._docId)}')">삭제</button>`
        }
      </div>
    </div>
  </div>`;
}

// ─── LIST VIEW ───
function renderListView(n, isTrash) {
  const catIdx = getCatColorIdx(n.category);
  const ccClass = catIdx >= 0 ? `cc${catIdx}` : 'cc-none';
  const cdClass = catIdx >= 0 ? `cd${catIdx}` : 'cd-none';
  const catName = getCatById(n.category)?.name || '카테고리없음';
  const cbClass = catIdx >= 0 ? `cb${catIdx}` : 'cb-none';
  const preview = (n.content || '').replace(/\n/g,' ').slice(0, 80);
  return `<div class="note-list-item ${ccClass}" onclick="openDetail('${esc(n._docId)}',${isTrash})">
    <span class="list-cat-dot ${cdClass}"></span>
    <div class="list-main">
      <div class="list-title">${esc(n.title||'제목 없음')}</div>
      ${preview ? `<div class="list-preview">${esc(preview)}</div>` : ''}
      ${(n.tags||[]).length ? `<div class="list-tags">${(n.tags||[]).slice(0,4).map(t=>`<span class="list-tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="list-right">
      <span class="cat-badge ${cbClass}" style="font-size:9px">${esc(catName)}</span>
      <span class="list-date">${fmt(n.createdAt)}</span>
      <div class="list-actions">
        ${isTrash
          ? `<button class="nact green" onclick="event.stopPropagation();doRestore('${esc(n._docId)}')">복원</button>
             <button class="nact del" onclick="event.stopPropagation();doPermDelete('${esc(n._docId)}')">완전삭제</button>`
          : `<button class="nact" onclick="event.stopPropagation();editNote('${esc(n._docId)}')">수정</button>
             <button class="nact del" onclick="event.stopPropagation();doTrash('${esc(n._docId)}')">삭제</button>`
        }
      </div>
    </div>
  </div>`;
}

// ─── MAGAZINE VIEW ───
function renderMagazineView(n, isTrash) {
  const catIdx = getCatColorIdx(n.category);
  const mbgClass = catIdx >= 0 ? `mbg${catIdx}` : 'mbg-none';
  const ccClass = catIdx >= 0 ? `cc${catIdx}` : 'cc-none';
  const cbClass = catIdx >= 0 ? `cb${catIdx}` : 'cb-none';
  const catName = getCatById(n.category)?.name || '카테고리없음';
  const emoji = getCatEmoji(catIdx);
  return `<div class="note-magazine ${ccClass}" onclick="openDetail('${esc(n._docId)}',${isTrash})">
    <div class="mag-header ${mbgClass}">
      ${emoji}
      <div class="mag-header-bar" style="${catIdx>=0 ? `background:linear-gradient(90deg,var(--accent),transparent)` : ''}"></div>
    </div>
    <div class="mag-body">
      <div class="note-head">
        <div class="note-title" style="-webkit-line-clamp:2">${esc(n.title||'제목 없음')}</div>
        <span class="cat-badge ${cbClass}">${esc(catName)}</span>
      </div>
      ${n.content ? `<div class="note-body">${esc(n.content)}</div>` : ''}
      ${renderLinkChips(n.links)}
      ${renderTagChips(n.tags)}
      <div class="note-footer">
        <div class="note-dates"><span>📅 ${fmt(n.createdAt)}</span></div>
        <div class="note-actions">
          ${isTrash
            ? `<button class="nact green" onclick="event.stopPropagation();doRestore('${esc(n._docId)}')">복원</button>
               <button class="nact del" onclick="event.stopPropagation();doPermDelete('${esc(n._docId)}')">완전삭제</button>`
            : `<button class="nact" onclick="event.stopPropagation();editNote('${esc(n._docId)}')">수정</button>
               <button class="nact del" onclick="event.stopPropagation();doTrash('${esc(n._docId)}')">삭제</button>`
          }
        </div>
      </div>
    </div>
  </div>`;
}

function getCatEmoji(idx) {
  const emojis = ['💼','🌿','💡','🔮','🌊','🌸','🍀','⭐'];
  return idx >= 0 ? emojis[idx % emojis.length] : '📝';
}

// ─── LINK CHIPS ───
function renderLinkChips(links) {
  if (!links || !links.length) return '';
  const valid = links.filter(l => l && l.url);
  if (!valid.length) return '';
  return `<div class="note-links-row">${valid.map(l => {
    const favicon = getFaviconUrl(l.url);
    const label = l.label || getDomain(l.url);
    return `<a class="link-chip" href="${esc(l.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
      ${favicon ? `<img class="link-favicon" src="${esc(favicon)}" alt="" onerror="this.style.display='none'">` : '🔗'}
      <span class="link-label">${esc(label)}</span>
    </a>`;
  }).join('')}</div>`;
}

function renderTagChips(tags) {
  if (!tags || !tags.length) return '';
  return `<div class="note-tags-row">${tags.map(t=>`<span class="note-tag">#${esc(t)}</span>`).join('')}</div>`;
}

// ══════════════════════════════════════════════
// 네비게이션
// ══════════════════════════════════════════════
window.selectNav = function(nav) {
  currentNav = nav;
  renderPageTitle();
  renderAll();
  // mobile: close sidebar
  if (window.innerWidth <= 768) closeSidebarMobile();
};

// ══════════════════════════════════════════════
// VIEW MODE
// ══════════════════════════════════════════════
window.setView = function(mode) {
  currentView = mode;
  ['grid','list','magazine'].forEach(m => {
    document.getElementById(`vb-${m}`).classList.toggle('active', m === mode);
  });
  renderNotes();
};

// ══════════════════════════════════════════════
// SIDEBAR TOGGLE
// ══════════════════════════════════════════════
let sidebarCollapsed = false;

window.toggleSidebar = function() {
  const sidebar = document.getElementById('sidebar');
  const main = document.getElementById('main-content');
  if (window.innerWidth <= 768) {
    // mobile: slide overlay
    sidebar.classList.toggle('mobile-open');
    document.getElementById('sidebar-overlay').classList.toggle('show', sidebar.classList.contains('mobile-open'));
  } else {
    sidebarCollapsed = !sidebarCollapsed;
    sidebar.classList.toggle('collapsed', sidebarCollapsed);
    main.classList.toggle('expanded', sidebarCollapsed);
  }
};
window.closeSidebarMobile = function() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('show');
};

// ══════════════════════════════════════════════
// DELETE / RESTORE ACTIONS
// ══════════════════════════════════════════════
window.doTrash = async function(docId) {
  const n = notes.find(x => x._docId === docId);
  if (!n) return;
  if (!confirm(`"${n.title||'이 메모'}"를 휴지통으로 이동하시겠습니까?`)) return;
  try {
    await moveToTrash(docId);
    closeDetailModal();
    renderAll();
    showToast('휴지통으로 이동했습니다.', 'success');
  } catch(e) { showToast('오류: ' + e.message, 'error'); }
};

window.doRestore = async function(docId) {
  try {
    await restoreNote(docId);
    closeDetailModal();
    renderAll();
    showToast('복원되었습니다.', 'success');
  } catch(e) { showToast('오류: ' + e.message, 'error'); }
};

window.doPermDelete = async function(docId) {
  if (!confirm('완전히 삭제합니다. 복구할 수 없습니다. 계속하시겠습니까?')) return;
  try {
    await permanentDelete(docId);
    closeDetailModal();
    renderAll();
    showToast('영구 삭제되었습니다.', 'success');
  } catch(e) { showToast('오류: ' + e.message, 'error'); }
};

// ══════════════════════════════════════════════
// ADD / EDIT MODAL
// ══════════════════════════════════════════════
window.openAddModal = function() {
  editingDocId = null;
  editTags = [];
  editLinks = [];
  document.getElementById('modal-title').textContent = '새 메모';
  document.getElementById('note-title-input').value = '';
  document.getElementById('note-content-input').value = '';
  renderCatSelect();
  // pre-select current category if in cat nav
  if (currentNav.startsWith('cat:')) {
    document.getElementById('note-cat-select').value = currentNav.slice(4);
  } else {
    document.getElementById('note-cat-select').value = '';
  }
  renderTagPreview();
  renderLinksList();
  document.getElementById('edit-modal').classList.add('open');
  setTimeout(() => document.getElementById('note-title-input').focus(), 100);
};

window.editNote = function(docId) {
  const n = notes.find(x => x._docId === docId);
  if (!n) return;
  editingDocId = docId;
  editTags = [...(n.tags||[])];
  editLinks = (n.links||[]).map(l => ({...l}));
  document.getElementById('modal-title').textContent = '메모 수정';
  document.getElementById('note-title-input').value = n.title||'';
  document.getElementById('note-content-input').value = n.content||'';
  renderCatSelect();
  document.getElementById('note-cat-select').value = n.category||'';
  renderTagPreview();
  renderLinksList();
  document.getElementById('edit-modal').classList.add('open');
  closeDetailModal();
};

window.closeModal = function() {
  document.getElementById('edit-modal').classList.remove('open');
};

window.saveNote = async function() {
  const title = document.getElementById('note-title-input').value.trim();
  const content = document.getElementById('note-content-input').value.trim();
  const category = document.getElementById('note-cat-select').value;
  if (!title) { showToast('제목을 입력해주세요.', 'error'); return; }
  const contentTags = extractTags(content);
  const finalTags = [...new Set([...editTags, ...contentTags])];
  const data = { title, content, category, tags: finalTags, links: editLinks.filter(l => l && l.url) };
  try {
    if (editingDocId) { await updateNote(editingDocId, data); showToast('수정되었습니다.', 'success'); }
    else { await addNote(data); showToast('저장되었습니다.', 'success'); }
    closeModal();
    renderAll();
  } catch(e) { showToast('저장 실패: ' + e.message, 'error'); }
};

window.handleOverlayClick = function(e, id) {
  if (e.target.id === id) {
    if (id === 'edit-modal') closeModal();
    else closeDetailModal();
  }
};

// Content auto tag extraction
document.getElementById('note-content-input').addEventListener('input', function() {
  const tags = extractTags(this.value);
  tags.forEach(t => { if (!editTags.includes(t)) editTags.push(t); });
  renderTagPreview();
});

// ── LINKS ──
window.addLinkRow = function() {
  editLinks.push({ label: '', url: '' });
  renderLinksList();
};

function renderLinksList() {
  const container = document.getElementById('links-list');
  container.innerHTML = editLinks.map((l, i) => {
    const favicon = l.url ? getFaviconUrl(l.url) : '';
    return `<div class="link-input-row">
      ${favicon ? `<img class="link-input-favicon" src="${esc(favicon)}" alt="" onerror="this.src=''">` : '<span style="font-size:14px">🔗</span>'}
      <input type="text" placeholder="표시 이름" value="${esc(l.label)}" style="max-width:130px"
        oninput="editLinks[${i}].label=this.value">
      <span class="link-input-sep">|</span>
      <input type="url" placeholder="https://..." value="${esc(l.url)}"
        oninput="editLinks[${i}].url=this.value;updateFavicon(${i},this.value)">
      <button class="link-del-btn" onclick="removeLink(${i})">✕</button>
    </div>`;
  }).join('');
}

window.updateFavicon = function(i, url) {
  // debounce favicon update
  clearTimeout(window._favTimer);
  window._favTimer = setTimeout(() => renderLinksList(), 800);
};

window.removeLink = function(i) {
  editLinks.splice(i, 1);
  renderLinksList();
};

// ── TAGS ──
function renderTagPreview() {
  const el = document.getElementById('tag-preview');
  if (!editTags.length) {
    el.innerHTML = '<span style="font-size:11px;color:var(--text3)">내용에 #태그를 입력하면 자동으로 표시됩니다</span>';
    return;
  }
  el.innerHTML = editTags.map((t, i) =>
    `<span class="tag-item">#${esc(t)} <span class="tag-remove" onclick="removeTag(${i})">✕</span></span>`
  ).join('');
}

window.removeTag = function(i) {
  editTags.splice(i, 1);
  renderTagPreview();
};

// ══════════════════════════════════════════════
// DETAIL MODAL
// ══════════════════════════════════════════════
window.openDetail = function(docId, isTrash=false) {
  const list = isTrash ? trashedNotes : notes;
  const n = list.find(x => x._docId === docId);
  if (!n) return;
  const catIdx = getCatColorIdx(n.category);
  const cbClass = catIdx >= 0 ? `cb${catIdx}` : 'cb-none';
  const catName = getCatById(n.category)?.name || '카테고리없음';
  const linksHtml = (n.links||[]).filter(l=>l&&l.url).length
    ? `<div style="display:flex;flex-wrap:wrap;gap:8px">${(n.links||[]).filter(l=>l&&l.url).map(l => {
        const fav = getFaviconUrl(l.url);
        return `<a class="detail-link-card" href="${esc(l.url)}" target="_blank" rel="noopener">
          ${fav ? `<img src="${esc(fav)}" alt="" onerror="this.style.display='none'">` : '🔗'}
          <div class="detail-link-info">
            <div class="detail-link-label">${esc(l.label||getDomain(l.url))}</div>
            <div class="detail-link-url">${esc(getDomain(l.url))}</div>
          </div>
        </a>`;
      }).join('')}</div>` : '';

  document.getElementById('detail-title').textContent = n.title || '제목 없음';
  document.getElementById('detail-body').innerHTML = `
    <span class="cat-badge ${cbClass}" style="width:fit-content">${esc(catName)}</span>
    ${n.content ? `<div class="detail-content">${esc(n.content)}</div>` : ''}
    ${linksHtml}
    ${(n.tags||[]).length ? `<div class="note-tags-row">${(n.tags||[]).map(t=>`<span class="note-tag">#${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="detail-meta">
      <span>📅 작성: ${fmt(n.createdAt)}</span>
      <span>✏️ 수정: ${fmt(n.updatedAt)}</span>
      ${isTrash && n.deletedAt ? `<span style="color:var(--red)">🗑 삭제: ${fmt(n.deletedAt)}</span>` : ''}
    </div>`;

  const footer = document.getElementById('detail-footer');
  if (isTrash) {
    footer.innerHTML = `
      <button class="btn btn-ghost" onclick="closeDetailModal()">닫기</button>
      <button class="btn btn-ghost" style="color:var(--green);border-color:rgba(0,200,150,.3)" onclick="doRestore('${esc(docId)}')">🔄 복원</button>
      <button class="btn btn-danger" onclick="doPermDelete('${esc(docId)}')">🗑 완전삭제</button>`;
  } else {
    footer.innerHTML = `
      <button class="btn btn-ghost" onclick="closeDetailModal()">닫기</button>
      <button class="btn btn-ghost" onclick="doTrash('${esc(docId)}')">🗑 삭제</button>
      <button class="btn btn-primary" onclick="editNote('${esc(docId)}')">✏️ 수정</button>`;
  }

  document.getElementById('detail-modal').classList.add('open');
};

window.closeDetailModal = function() {
  document.getElementById('detail-modal').classList.remove('open');
};

// ══════════════════════════════════════════════
// 검색 & 정렬
// ══════════════════════════════════════════════
document.getElementById('search-input').addEventListener('input', () => { renderNotes(); renderStats(); });
document.getElementById('sort-select').addEventListener('change', () => renderNotes());

// ══════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════
function fmt(d) {
  if (!d) return '-';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '-';
  const p = n => String(n).padStart(2,'0');
  return `${dt.getFullYear()}.${p(dt.getMonth()+1)}.${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
window.esc = esc;

function setSyncStatus(state) {
  const el = document.getElementById('sync-status');
  if (state==='ok'){el.textContent='🔥 연결됨';el.className='sync-status sync-ok';}
  else if(state==='loading'){el.textContent='⏳ 동기화 중...';el.className='sync-status sync-loading';}
  else{el.textContent='❌ 오류';el.className='sync-status sync-error';}
}

function showToast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3500);
}
window.showToast = showToast;

// ══════════════════════════════════════════════
// Google 인증
// ══════════════════════════════════════════════
window.googleLogin = async () => {
  try { await signInWithPopup(auth, provider); }
  catch(e) { if (e.code !== 'auth/popup-closed-by-user') alert('로그인 실패: ' + e.message); }
};
window.googleLogout = async () => {
  if (confirm('로그아웃 하시겠습니까?')) await signOut(auth);
};

// ══════════════════════════════════════════════
// 초기화
// ══════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  const loginScreen   = document.getElementById('login-screen');
  const loadingScreen = document.getElementById('loading-screen');
  if (user) {
    currentUser = user;
    loginScreen.classList.add('hidden');
    loadingScreen.classList.remove('hidden');
    const userBtn = document.getElementById('user-btn');
    const logoutBtn = document.getElementById('logout-btn');
    userBtn.style.display = 'flex';
    logoutBtn.style.display = 'block';
    document.getElementById('user-name').textContent = user.displayName || user.email;
    const avatarEl = document.getElementById('user-avatar');
    const fallbackEl = document.getElementById('user-avatar-fallback');
    if (user.photoURL) { avatarEl.src = user.photoURL; avatarEl.style.display = 'block'; fallbackEl.style.display = 'none'; }
    else { fallbackEl.textContent = (user.displayName||user.email||'?')[0].toUpperCase(); }
    await loadAll();
    loadingScreen.classList.add('hidden');
    renderPageTitle();
    renderAll();
  } else {
    currentUser = null; notes = []; trashedNotes = []; categories = [];
    loadingScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    document.getElementById('user-btn').style.display = 'none';
    document.getElementById('logout-btn').style.display = 'none';
  }
});
