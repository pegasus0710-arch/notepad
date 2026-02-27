import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, doc, getDocs, addDoc, deleteDoc, setDoc, serverTimestamp }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// ══════════════════════════════════════════════
// Firebase 설정 (본인의 프로젝트 설정으로 교체하세요)
// ══════════════════════════════════════════════
const firebaseConfig = {
apiKey: "AIzaSyComDARleCbTfzB9LTdS211DSSHp1PXIPk",
  authDomain: "notepad-e6a66.firebaseapp.com",
  projectId: "notepad-e6a66",
  storageBucket: "notepad-e6a66.firebasestorage.app",
  messagingSenderId: "739275664534",
  appId: "1:739275664534:web:8368fdffb5d8f3d67da6b7",
  measurementId: "G-GN1FNHRGBE"
};
const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// ══════════════════════════════════════════════
// 상태
// ══════════════════════════════════════════════
let currentUser = null;
let notes = [];       // { _docId, id, title, content, category, links:[], tags:[], createdAt, updatedAt }
let editingDocId = null;
let currentCategory = '__all__';
let editTags = [];
let editLinks = [];   // [{label, url}]

// ══════════════════════════════════════════════
// Firebase CRUD
// ══════════════════════════════════════════════
function notesCol() {
  return collection(db, 'users', currentUser.uid, 'notes');
}

async function loadNotes() {
  setSyncStatus('loading');
  try {
    const snap = await getDocs(notesCol());
    notes = snap.docs.map(d => {
      const data = d.data();
      return {
        ...data,
        _docId: d.id,
        createdAt: data.createdAt?.toDate?.() || new Date(data.createdAt || Date.now()),
        updatedAt: data.updatedAt?.toDate?.() || new Date(data.updatedAt || Date.now()),
      };
    });
    setSyncStatus('ok');
  } catch(e) {
    console.error(e);
    setSyncStatus('error');
  }
}

async function addNote(data) {
  const payload = {
    ...data,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const ref = await addDoc(notesCol(), payload);
  const now = new Date();
  notes.push({ ...data, _docId: ref.id, createdAt: now, updatedAt: now });
}

async function updateNote(docId, data) {
  const payload = { ...data, updatedAt: serverTimestamp() };
  await setDoc(doc(notesCol(), docId), payload, { merge: true });
  const idx = notes.findIndex(n => n._docId === docId);
  if (idx !== -1) {
    notes[idx] = { ...notes[idx], ...data, updatedAt: new Date() };
  }
}

async function deleteNote(docId) {
  await deleteDoc(doc(notesCol(), docId));
  notes = notes.filter(n => n._docId !== docId);
}

// ══════════════════════════════════════════════
// 태그 자동 추출
// ══════════════════════════════════════════════
function extractTags(text) {
  const hashTags = (text.match(/#[\w가-힣]+/g) || []).map(t => t.slice(1));
  return [...new Set(hashTags)];
}

// ══════════════════════════════════════════════
// 카테고리 색상 매핑
// ══════════════════════════════════════════════
const PRESET_CATS = ['업무','개인','아이디어','참고','링크','기타'];
function getCatClass(cat) {
  return PRESET_CATS.includes(cat) ? `cat-${cat}` : 'cat-custom';
}
function getCatAttr(cat) {
  return PRESET_CATS.includes(cat) ? `data-cat="${cat}"` : `data-cat-custom="${cat}"`;
}
const CAT_DOT_COLORS = {
  '업무':'#3d7fff', '개인':'#00c896', '아이디어':'#ffd060',
  '참고':'#a855f7', '링크':'#06b6d4', '기타':'#5a6e9a',
};
function getCatDotColor(cat) {
  return CAT_DOT_COLORS[cat] || '#ec4899';
}

// ══════════════════════════════════════════════
// 필터 & 정렬
// ══════════════════════════════════════════════
function getSearchQuery() {
  return (document.getElementById('search-input')?.value || '').trim().toLowerCase();
}
function getSortMode() {
  return document.getElementById('sort-select')?.value || 'created_desc';
}

function getFilteredSorted() {
  const q = getSearchQuery();
  const sort = getSortMode();

  let list = [...notes];

  // 카테고리 필터
  if (currentCategory !== '__all__') {
    list = list.filter(n => n.category === currentCategory);
  }

  // 검색 필터
  if (q) {
    list = list.filter(n =>
      (n.title||'').toLowerCase().includes(q) ||
      (n.content||'').toLowerCase().includes(q) ||
      (n.tags||[]).some(t => t.toLowerCase().includes(q)) ||
      (n.category||'').toLowerCase().includes(q)
    );
  }

  // 정렬
  list.sort((a, b) => {
    const at = new Date(a[sort.startsWith('created') ? 'createdAt' : 'updatedAt']);
    const bt = new Date(b[sort.startsWith('created') ? 'createdAt' : 'updatedAt']);
    return sort.endsWith('desc') ? bt - at : at - bt;
  });

  return list;
}

// ══════════════════════════════════════════════
// 렌더링
// ══════════════════════════════════════════════
function renderAll() {
  renderCatBar();
  renderNotes();
  renderStats();
}

function renderCatBar() {
  const catBar = document.getElementById('cat-bar-inner');
  const allCats = [...new Set(notes.map(n => n.category).filter(Boolean))];

  const makeCatTab = (cat, label, count) => {
    const isActive = currentCategory === cat;
    const dotColor = cat === '__all__' ? '#8fa0c8' : getCatDotColor(label || cat);
    return `<div class="cat-tab${isActive ? ' active' : ''}" onclick="selectCategory('${esc(cat)}')">
      <span class="cat-dot" style="background:${dotColor}"></span>
      ${esc(label || cat)}
      <span class="cnt">${count}</span>
    </div>`;
  };

  let html = makeCatTab('__all__', '전체', notes.length);
  allCats.forEach(cat => {
    const count = notes.filter(n => n.category === cat).length;
    html += makeCatTab(cat, cat, count);
  });
  catBar.innerHTML = html;
}

function renderNotes() {
  const grid = document.getElementById('notes-grid');
  const list = getFilteredSorted();

  if (list.length === 0) {
    const q = getSearchQuery();
    grid.innerHTML = `<div class="notes-empty">
      <div class="notes-empty-icon">${q ? '🔍' : '📭'}</div>
      <p>${q ? `'${esc(q)}' 검색 결과가 없습니다.` : '메모가 없습니다. 새 메모를 작성해보세요!'}</p>
    </div>`;
    return;
  }

  grid.innerHTML = list.map(n => renderNoteCard(n)).join('');
}

function renderNoteCard(n) {
  const catClass = getCatClass(n.category||'기타');
  const catAttr = getCatAttr(n.category||'기타');
  const tagsHtml = (n.tags||[]).length
    ? `<div class="note-tags">${(n.tags||[]).map(t => `<span class="note-tag">#${esc(t)}</span>`).join('')}</div>`
    : '';
  const linksHtml = (n.links||[]).filter(l=>l.url).length
    ? `<div class="note-links">${(n.links||[]).filter(l=>l.url).map(l =>
        `<a class="note-link-chip" href="${esc(l.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
          🔗 ${esc(l.label || shortenUrl(l.url))}
        </a>`).join('')}</div>`
    : '';

  return `<div class="note-card" ${catAttr} onclick="openDetail('${esc(n._docId)}')">
    <div class="note-card-head">
      <div class="note-title">${esc(n.title||'제목 없음')}</div>
      <span class="note-cat-badge ${catClass}">${esc(n.category||'기타')}</span>
    </div>
    ${n.content ? `<div class="note-body">${esc(n.content)}</div>` : ''}
    ${linksHtml}
    ${tagsHtml}
    <div class="note-footer">
      <div class="note-footer-dates">
        <span>📅 ${fmtDatetime(n.createdAt)}</span>
        ${n.updatedAt && fmtDatetime(n.updatedAt) !== fmtDatetime(n.createdAt)
          ? `<span>✏️ ${fmtDatetime(n.updatedAt)}</span>` : ''}
      </div>
      <div class="note-footer-actions">
        <button class="note-action-btn" onclick="event.stopPropagation();editNote('${esc(n._docId)}')">수정</button>
        <button class="note-action-btn del" onclick="event.stopPropagation();confirmDelete('${esc(n._docId)}')">삭제</button>
      </div>
    </div>
  </div>`;
}

function renderStats() {
  const list = getFilteredSorted();
  const bar = document.getElementById('stats-bar');
  const catCounts = {};
  list.forEach(n => { catCounts[n.category||'기타'] = (catCounts[n.category||'기타']||0)+1; });
  const q = getSearchQuery();
  bar.innerHTML = `
    <div class="stat-item">전체 <strong>${notes.length}</strong>개</div>
    <div class="stat-item">표시 <strong>${list.length}</strong>개</div>
    ${q ? `<div class="stat-item">검색: <strong>"${esc(q)}"</strong></div>` : ''}
    ${Object.entries(catCounts).slice(0,4).map(([c,v]) =>
      `<div class="stat-item">${esc(c)} <strong>${v}</strong></div>`).join('')}
  `;
}

// ══════════════════════════════════════════════
// MODAL – 추가/수정
// ══════════════════════════════════════════════
window.openAddModal = function() {
  editingDocId = null;
  editTags = [];
  editLinks = [];
  document.getElementById('modal-title').textContent = '새 메모';
  document.getElementById('note-title-input').value = '';
  document.getElementById('note-content-input').value = '';
  document.getElementById('note-cat-select').value = '업무';
  document.getElementById('custom-cat-group').style.display = 'none';
  document.getElementById('note-custom-cat').value = '';
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

  const selectEl = document.getElementById('note-cat-select');
  if (PRESET_CATS.includes(n.category)) {
    selectEl.value = n.category;
    document.getElementById('custom-cat-group').style.display = 'none';
  } else {
    selectEl.value = '__custom__';
    document.getElementById('custom-cat-group').style.display = 'flex';
    document.getElementById('note-custom-cat').value = n.category||'';
  }

  renderTagPreview();
  renderLinksList();
  document.getElementById('edit-modal').classList.add('open');
  closeDetailModal();
};

window.closeModal = function() {
  document.getElementById('edit-modal').classList.remove('open');
};

window.handleOverlayClick = function(e) {
  if (e.target.id === 'edit-modal') closeModal();
};

window.saveNote = async function() {
  const title = document.getElementById('note-title-input').value.trim();
  const content = document.getElementById('note-content-input').value.trim();
  const catSelect = document.getElementById('note-cat-select').value;
  const category = catSelect === '__custom__'
    ? (document.getElementById('note-custom-cat').value.trim() || '기타')
    : catSelect;

  if (!title) { showToast('제목을 입력해주세요.', 'error'); return; }

  // 내용에서 태그 자동 보완
  const contentTags = extractTags(content);
  const finalTags = [...new Set([...editTags, ...contentTags])];

  const data = {
    title, content, category,
    tags: finalTags,
    links: editLinks.filter(l => l.url),
  };

  try {
    if (editingDocId) {
      await updateNote(editingDocId, data);
      showToast('메모가 수정되었습니다.', 'success');
    } else {
      await addNote(data);
      showToast('메모가 저장되었습니다.', 'success');
    }
    closeModal();
    renderAll();
  } catch(e) {
    console.error(e);
    showToast('저장 중 오류가 발생했습니다.', 'error');
  }
};

// ── 카테고리 select 이벤트
document.getElementById('note-cat-select').addEventListener('change', function() {
  document.getElementById('custom-cat-group').style.display =
    this.value === '__custom__' ? 'flex' : 'none';
});

// ── 내용 입력 시 태그 자동 추출 미리보기
document.getElementById('note-content-input').addEventListener('input', function() {
  const contentTags = extractTags(this.value);
  contentTags.forEach(t => { if (!editTags.includes(t)) editTags.push(t); });
  renderTagPreview();
});

// ══════════════════════════════════════════════
// 링크 관리
// ══════════════════════════════════════════════
window.addLinkRow = function(label='', url='') {
  editLinks.push({ label, url });
  renderLinksList();
};

function renderLinksList() {
  const container = document.getElementById('links-list');
  container.innerHTML = editLinks.map((l, i) => `
    <div class="link-row">
      <input type="text" class="form-control" placeholder="표시 이름 (선택)" value="${esc(l.label)}"
        oninput="editLinks[${i}].label=this.value" style="max-width:160px">
      <input type="url" class="form-control" placeholder="https://..." value="${esc(l.url)}"
        oninput="editLinks[${i}].url=this.value">
      <button class="link-del-btn" onclick="removeLink(${i})">✕</button>
    </div>
  `).join('');
}

window.removeLink = function(i) {
  editLinks.splice(i, 1);
  renderLinksList();
};

// ══════════════════════════════════════════════
// 태그 관리
// ══════════════════════════════════════════════
function renderTagPreview() {
  const container = document.getElementById('tag-preview');
  if (editTags.length === 0) {
    container.innerHTML = '<span style="font-size:12px;color:var(--text3)">내용에 #태그를 입력하면 자동으로 표시됩니다</span>';
    return;
  }
  container.innerHTML = editTags.map((t, i) =>
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
window.openDetail = function(docId) {
  const n = notes.find(x => x._docId === docId);
  if (!n) return;

  document.getElementById('detail-title').textContent = n.title || '제목 없음';

  const catClass = getCatClass(n.category||'기타');
  const linksHtml = (n.links||[]).filter(l=>l.url).length
    ? `<div class="detail-links">${(n.links||[]).filter(l=>l.url).map(l =>
        `<a class="note-link-chip" href="${esc(l.url)}" target="_blank" rel="noopener">
          🔗 ${esc(l.label || l.url)}
        </a>`).join('')}</div>`
    : '';
  const tagsHtml = (n.tags||[]).length
    ? `<div class="note-tags">${(n.tags||[]).map(t=>`<span class="note-tag">#${esc(t)}</span>`).join('')}</div>`
    : '';

  document.getElementById('detail-body').innerHTML = `
    <span class="note-cat-badge ${catClass}" style="width:fit-content">${esc(n.category||'기타')}</span>
    <div class="detail-content">${esc(n.content||'내용 없음')}</div>
    ${linksHtml}
    ${tagsHtml}
    <div class="detail-meta">
      <span>📅 작성: ${fmtDatetime(n.createdAt)}</span>
      <span>✏️ 수정: ${fmtDatetime(n.updatedAt)}</span>
    </div>
  `;

  document.getElementById('detail-edit-btn').onclick = () => editNote(docId);
  document.getElementById('detail-delete-btn').onclick = () => { closeDetailModal(); confirmDelete(docId); };

  document.getElementById('detail-modal').classList.add('open');
};

window.closeDetailModal = function() {
  document.getElementById('detail-modal').classList.remove('open');
};

window.handleDetailOverlayClick = function(e) {
  if (e.target.id === 'detail-modal') closeDetailModal();
};

// ══════════════════════════════════════════════
// 삭제
// ══════════════════════════════════════════════
window.confirmDelete = async function(docId) {
  const n = notes.find(x => x._docId === docId);
  if (!n) return;
  if (!confirm(`"${n.title||'이 메모'}" 를 삭제하시겠습니까?`)) return;
  try {
    await deleteNote(docId);
    showToast('삭제되었습니다.', 'success');
    renderAll();
  } catch(e) {
    showToast('삭제 실패: ' + e.message, 'error');
  }
};

// ══════════════════════════════════════════════
// 카테고리 선택
// ══════════════════════════════════════════════
window.selectCategory = function(cat) {
  currentCategory = cat;
  renderAll();
};

// ══════════════════════════════════════════════
// 검색 & 정렬 이벤트
// ══════════════════════════════════════════════
document.getElementById('search-input').addEventListener('input', () => renderNotes() & renderStats());
document.getElementById('sort-select').addEventListener('change', () => renderNotes());

// ══════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════
function fmtDatetime(d) {
  if (!d) return '-';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '-';
  const pad = n => String(n).padStart(2,'0');
  return `${dt.getFullYear()}.${pad(dt.getMonth()+1)}.${pad(dt.getDate())} `
       + `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

function shortenUrl(url) {
  try { return new URL(url).hostname.replace('www.',''); }
  catch { return url.slice(0,30); }
}

function esc(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
window.esc = esc;

function setSyncStatus(state) {
  const el = document.getElementById('sync-status');
  if (state === 'ok')      { el.textContent='🔥 Firebase 연결됨'; el.className='sync-status sync-ok'; }
  else if (state==='loading'){ el.textContent='⏳ 동기화 중...'; el.className='sync-status sync-loading'; }
  else                     { el.textContent='❌ 연결 오류'; el.className='sync-status sync-error'; }
}

function showToast(msg, type='success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
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
const loginScreen   = document.getElementById('login-screen');
const loadingScreen = document.getElementById('loading-screen');
const mainContent   = document.getElementById('main-content');

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    loginScreen.classList.add('hidden');
    loadingScreen.classList.remove('hidden');

    // 사용자 UI
    const userBtn = document.getElementById('user-btn');
    const logoutBtn = document.getElementById('logout-btn');
    userBtn.style.display = 'flex';
    logoutBtn.style.display = 'block';
    document.getElementById('user-name').textContent = user.displayName || user.email;

    const avatarEl = document.getElementById('user-avatar');
    const fallbackEl = document.getElementById('user-avatar-fallback');
    if (user.photoURL) {
      avatarEl.src = user.photoURL; avatarEl.style.display = 'block';
      fallbackEl.style.display = 'none';
    } else {
      fallbackEl.textContent = (user.displayName || user.email || '?')[0].toUpperCase();
    }

    await loadNotes();
    loadingScreen.classList.add('hidden');
    renderAll();
  } else {
    currentUser = null;
    notes = [];
    loadingScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
    document.getElementById('user-btn').style.display = 'none';
    document.getElementById('logout-btn').style.display = 'none';
  }
});
