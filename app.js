import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import { getFirestore, collection, doc, getDocs, addDoc, deleteDoc, setDoc, serverTimestamp, writeBatch }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// ═══════════════════════════════════════
// Firebase 설정
// ═══════════════════════════════════════
const firebaseConfig = {
  apiKey:            "AIzaSyComDAR1eCbTfzB9LTdS211DSSHp1PXIPk",
  authDomain:        "notepad-e6a66.firebaseapp.com",
  projectId:         "notepad-e6a66",
  storageBucket:     "notepad-e6a66.firebasestorage.app",
  messagingSenderId: "739275664534",
  appId:             "1:739275664534:web:8368fdffb5d8f3d67da6b7",
  measurementId:     "G-GN1FNHRGBE"
};
const fbApp    = initializeApp(firebaseConfig);
const db       = getFirestore(fbApp);
const auth     = getAuth(fbApp);
const gProvider = new GoogleAuthProvider();

// ═══════════════════════════════════════
// App State
// ═══════════════════════════════════════
let me = null;          // current user
let notes     = [];     // active notes
let trashed   = [];     // deleted notes
let cats      = [];     // categories [{_id, name}]
let trashDays = 30;     // auto-delete period

let nav  = 'all';       // 'all' | 'trash' | 'cat:{id}'
let view = 'grid';      // 'grid' | 'list' | 'magazine'

// Edit modal state
let editId   = null;    // docId being edited (null = new)
let eTags    = [];      // current tag list
let eLinks   = [];      // current link list [{label, url}]

// ═══════════════════════════════════════
// Firestore helpers
// ═══════════════════════════════════════
const notesRef  = () => collection(db, 'users', me.uid, 'notes');
const catsRef   = () => collection(db, 'users', me.uid, 'categories');
const settRef   = () => doc(db, 'users', me.uid, 'settings', 'main');

// ═══════════════════════════════════════
// Load all data
// ═══════════════════════════════════════
async function loadAll() {
  setSyncStatus('ing');
  try {
    // Notes
    const ns = await getDocs(notesRef());
    const all = ns.docs.map(d => ({
      ...d.data(),
      _id: d.id,
      createdAt: toDate(d.data().createdAt),
      updatedAt: toDate(d.data().updatedAt),
      deletedAt: toDate(d.data().deletedAt),
    }));
    notes   = all.filter(n => !n.deleted);
    trashed = all.filter(n =>  n.deleted);

    // Categories
    const cs = await getDocs(catsRef());
    cats = cs.docs.map(d => ({ ...d.data(), _id: d.id }));

    // Settings
    try {
      const ss = await getDocs(collection(db, 'users', me.uid, 'settings'));
      ss.forEach(d => { if (d.id === 'main' && d.data().trashDays != null) trashDays = d.data().trashDays; });
      document.getElementById('trash-period').value = String(trashDays);
    } catch {}

    await pruneTrash();
    setSyncStatus('ok');
  } catch(e) {
    console.error(e);
    setSyncStatus('err');
  }
}

function toDate(v) {
  if (!v) return null;
  if (v?.toDate) return v.toDate();
  return new Date(v);
}

// ═══════════════════════════════════════
// Auto-prune expired trash
// ═══════════════════════════════════════
async function pruneTrash() {
  if (!trashDays) return;
  const cutoff = Date.now() - trashDays * 864e5;
  const expired = trashed.filter(n => n.deletedAt && new Date(n.deletedAt) < cutoff);
  if (!expired.length) return;
  const b = writeBatch(db);
  expired.forEach(n => b.delete(doc(notesRef(), n._id)));
  await b.commit();
  trashed = trashed.filter(n => !expired.find(e => e._id === n._id));
}

// ═══════════════════════════════════════
// Category helpers
// ═══════════════════════════════════════
function catById(id) { return cats.find(c => c._id === id) || null; }
function catIdx(id)  { const i = cats.findIndex(c => c._id === id); return i >= 0 ? i % 8 : -1; }
function catColor(id){ const i = catIdx(id); return i >= 0 ? i : null; }
const MAG_EMOJIS = ['💼','🌿','💡','🔮','🌊','🌸','🍀','⭐'];

// ═══════════════════════════════════════
// CATEGORY CRUD
// ═══════════════════════════════════════
window.addCat = async function() {
  const inp = document.getElementById('new-cat-inp');
  const name = inp.value.trim();
  if (!name) { inp.focus(); return; }
  if (cats.find(c => c.name === name)) { showToast(`'${name}' 이미 존재합니다.`, 'wrn'); return; }
  try {
    const ref = await addDoc(catsRef(), { name });
    cats.push({ _id: ref.id, name });
    inp.value = '';
    renderAll();
    showToast(`'${name}' 카테고리 추가됨 ✅`);
  } catch(e) { showToast('추가 실패: ' + e.message, 'err'); }
};

window.delCat = async function(id) {
  const cat = catById(id);
  if (!cat) return;
  if (!confirm(`'${cat.name}' 카테고리를 삭제하시겠습니까?\n해당 카테고리 메모는 '카테고리없음'으로 변경됩니다.`)) return;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(catsRef(), id));
    notes.filter(n => n.category === id).forEach(n => {
      batch.set(doc(notesRef(), n._id), { category: '', updatedAt: serverTimestamp() }, { merge: true });
      n.category = '';
    });
    await batch.commit();
    cats = cats.filter(c => c._id !== id);
    if (nav === `cat:${id}`) nav = 'all';
    renderAll();
    showToast(`'${cat.name}' 삭제됨`);
  } catch(e) { showToast('삭제 실패: ' + e.message, 'err'); }
};

// ═══════════════════════════════════════
// NOTE CRUD
// ═══════════════════════════════════════
async function createNote(data) {
  const payload = { ...data, deleted: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  const ref = await addDoc(notesRef(), payload);
  const now = new Date();
  notes.push({ ...data, deleted: false, _id: ref.id, createdAt: now, updatedAt: now });
}

async function updateNoteDoc(id, data) {
  await setDoc(doc(notesRef(), id), { ...data, updatedAt: serverTimestamp() }, { merge: true });
  const i = notes.findIndex(n => n._id === id);
  if (i >= 0) notes[i] = { ...notes[i], ...data, updatedAt: new Date() };
}

async function softDelete(id) {
  const now = serverTimestamp();
  await setDoc(doc(notesRef(), id), { deleted: true, deletedAt: now }, { merge: true });
  const n = notes.find(x => x._id === id);
  if (n) { n.deleted = true; n.deletedAt = new Date(); notes = notes.filter(x => x._id !== id); trashed.push(n); }
}

async function restoreNote(id) {
  await setDoc(doc(notesRef(), id), { deleted: false, deletedAt: null }, { merge: true });
  const n = trashed.find(x => x._id === id);
  if (n) { n.deleted = false; n.deletedAt = null; trashed = trashed.filter(x => x._id !== id); notes.push(n); }
}

async function hardDelete(id) {
  await deleteDoc(doc(notesRef(), id));
  trashed = trashed.filter(x => x._id !== id);
}

window.doTrash   = async function(id) {
  const n = notes.find(x => x._id === id);
  if (!confirm(`"${n?.title||'이 메모'}"를 휴지통으로 이동할까요?`)) return;
  try { await softDelete(id); closeDet(); renderAll(); showToast('휴지통으로 이동했습니다.'); }
  catch(e) { showToast('오류: ' + e.message, 'err'); }
};
window.doRestore = async function(id) {
  try { await restoreNote(id); closeDet(); renderAll(); showToast('복원되었습니다. ✅'); }
  catch(e) { showToast('오류: ' + e.message, 'err'); }
};
window.doHardDel = async function(id) {
  if (!confirm('완전히 삭제합니다. 복구할 수 없습니다.')) return;
  try { await hardDelete(id); closeDet(); renderAll(); showToast('영구 삭제됨'); }
  catch(e) { showToast('오류: ' + e.message, 'err'); }
};
window.emptyTrash = async function() {
  if (!trashed.length) { showToast('휴지통이 비어있습니다.', 'wrn'); return; }
  if (!confirm(`휴지통의 메모 ${trashed.length}개를 모두 영구 삭제할까요?`)) return;
  try {
    const b = writeBatch(db);
    trashed.forEach(n => b.delete(doc(notesRef(), n._id)));
    await b.commit();
    trashed = [];
    renderAll();
    showToast('휴지통을 비웠습니다.');
  } catch(e) { showToast('오류: ' + e.message, 'err'); }
};
window.saveTrashPeriod = async function() {
  trashDays = parseInt(document.getElementById('trash-period').value);
  await setDoc(settRef(), { trashDays }, { merge: true });
  showToast('설정 저장됨 ✅');
};

// ═══════════════════════════════════════
// Favicon / URL helpers
// ═══════════════════════════════════════
function favicon(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`; }
  catch { return ''; }
}
function domain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url.slice(0, 30); }
}

// ═══════════════════════════════════════
// Tag helpers
// ═══════════════════════════════════════
function extractTags(text) {
  return [...new Set((text.match(/#[\w가-힣]+/g) || []).map(t => t.slice(1)))];
}

// ═══════════════════════════════════════
// Filter + Sort
// ═══════════════════════════════════════
function filtered() {
  const q    = (document.getElementById('search-inp')?.value || '').trim().toLowerCase();
  const sort = document.getElementById('sort-sel')?.value || 'cd';
  const isT  = nav === 'trash';
  let list   = isT ? [...trashed] : [...notes];

  if (!isT && nav.startsWith('cat:')) {
    const cid = nav.slice(4);
    list = list.filter(n => n.category === cid);
  }
  if (q) {
    list = list.filter(n =>
      (n.title||'').toLowerCase().includes(q) ||
      (n.content||'').toLowerCase().includes(q) ||
      (n.tags||[]).some(t => t.toLowerCase().includes(q)) ||
      (catById(n.category)?.name||'').toLowerCase().includes(q)
    );
  }
  const key = (sort === 'cd' || sort === 'ca') ? 'createdAt' : 'updatedAt';
  const asc = sort === 'ca' || sort === 'ma';
  list.sort((a, b) => {
    const at = new Date(a[key]||0), bt = new Date(b[key]||0);
    return asc ? at - bt : bt - at;
  });
  return list;
}

// ═══════════════════════════════════════
// RENDER ALL
// ═══════════════════════════════════════
function renderAll() {
  renderSidebar();
  renderNotes();
  renderStats();
  fillCatSelect();
}

// ── SIDEBAR ──
function renderSidebar() {
  // counts
  document.getElementById('cnt-all').textContent = notes.length;
  const tc = document.getElementById('cnt-trash');
  if (trashed.length) { tc.textContent = trashed.length; tc.style.display = ''; }
  else tc.style.display = 'none';

  // nav active
  document.querySelectorAll('.nav-row').forEach(el => el.classList.remove('active'));
  if (nav === 'all')   document.getElementById('nav-all').classList.add('active');
  if (nav === 'trash') document.getElementById('nav-trash').classList.add('active');

  // trash config panel
  document.getElementById('trash-cfg-wrap').classList.toggle('hidden', nav !== 'trash');

  // cats
  const wrap = document.getElementById('cat-rows');
  if (!cats.length) {
    wrap.innerHTML = `<div style="font-size:11px;color:var(--text3);padding:4px 10px">카테고리가 없습니다.</div>`;
    return;
  }
  wrap.innerHTML = cats.map((c, i) => {
    const ci    = i % 8;
    const cnt   = notes.filter(n => n.category === c._id).length;
    const act   = nav === `cat:${c._id}`;
    return `<div class="cat-row${act ? ' active' : ''}" onclick="goNav('cat:${e(c._id)}')">
      <span class="cat-dot dc${ci}"></span>
      <span class="cat-name">${e(c.name)}</span>
      <span class="cat-cnt">${cnt}</span>
      <button class="cat-x" onclick="event.stopPropagation();delCat('${e(c._id)}')" title="삭제">✕</button>
    </div>`;
  }).join('');
}

// ── NOTES ──
function renderNotes() {
  const wrap = document.getElementById('notes-wrap');
  wrap.className = `view-${view}`;
  const list = filtered();
  const isT  = nav === 'trash';
  const q    = (document.getElementById('search-inp')?.value||'').trim();

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">
      <div class="empty-icon">${isT ? '🗑️' : q ? '🔍' : '📭'}</div>
      <p>${isT ? '휴지통이 비어있습니다.' : q ? `"${e(q)}" 검색 결과 없음` : '메모가 없습니다. 새 메모를 작성해보세요!'}</p>
    </div>`;
    return;
  }

  if (view === 'grid')     wrap.innerHTML = list.map(n => cardHtml(n, isT)).join('');
  else if (view === 'list') wrap.innerHTML = list.map(n => listHtml(n, isT)).join('');
  else                     wrap.innerHTML = list.map(n => magHtml(n, isT)).join('');
}

// ── STATS ──
function renderStats() {
  const list = filtered();
  document.getElementById('stats').innerHTML =
    `<span>표시 <strong>${list.length}</strong>개</span>` +
    `<span>전체 <strong>${notes.length}</strong>개</span>` +
    `<span>휴지통 <strong>${trashed.length}</strong>개</span>`;
}

// ── PAGE TITLE ──
function renderTitle() {
  const el = document.getElementById('page-hd');
  if      (nav === 'all')           el.textContent = '📝 전체 메모';
  else if (nav === 'trash')         el.textContent = '🗑️ 휴지통';
  else if (nav.startsWith('cat:')) {
    const c = catById(nav.slice(4));
    el.textContent = c ? `🗂️ ${c.name}` : '📝 메모';
  }
}

// ── CAT SELECT (modal) ──
function fillCatSelect() {
  const sel = document.getElementById('e-cat');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">카테고리없음</option>` +
    cats.map(c => `<option value="${e(c._id)}">${e(c.name)}</option>`).join('');
  sel.value = prev || '';
}

// ═══════════════════════════════════════
// HTML builders
// ═══════════════════════════════════════
function bcc(catId) {    // bar/card color class
  const i = catColor(catId); return i !== null ? `bc${i}` : 'bc-x';
}
function dcc(catId) {    // dot color class
  const i = catColor(catId); return i !== null ? `dc${i}` : 'dc-x';
}
function bdc(catId) {    // badge color class
  const i = catColor(catId); return i !== null ? `bdc${i}` : 'bdc-x';
}
function mbgc(catId) {   // magazine bg color class
  const i = catColor(catId); return i !== null ? `mbg${i}` : 'mbg-x';
}
function catLabel(catId) {
  return catById(catId)?.name || '카테고리없음';
}

function linksHtml(links) {
  if (!links?.length) return '';
  const valid = links.filter(l => l?.url);
  if (!valid.length) return '';
  return `<div class="n-links">${valid.map(l => {
    const fav = favicon(l.url);
    return `<a class="link-chip" href="${e(l.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
      ${fav ? `<img class="lc-fav" src="${e(fav)}" alt="" onerror="this.style.display='none'">` : '🔗'}
      <span class="lc-label">${e(l.label || domain(l.url))}</span>
    </a>`;
  }).join('')}</div>`;
}

function tagsHtml(tags) {
  if (!tags?.length) return '';
  return `<div class="n-tags">${tags.map(t => `<span class="n-tag">#${e(t)}</span>`).join('')}</div>`;
}

function actsBtns(id, isT) {
  if (isT) return `
    <button class="na green" onclick="event.stopPropagation();doRestore('${id}')">복원</button>
    <button class="na del"   onclick="event.stopPropagation();doHardDel('${id}')">완전삭제</button>`;
  return `
    <button class="na"      onclick="event.stopPropagation();openEdit('${id}')">수정</button>
    <button class="na del"  onclick="event.stopPropagation();doTrash('${id}')">삭제</button>`;
}

// ─ Card ─
function cardHtml(n, isT) {
  return `<div class="nc ${bcc(n.category)}" onclick="openDet('${n._id}',${isT})">
    <div class="n-head">
      <div class="n-title">${e(n.title||'제목 없음')}</div>
      <span class="n-badge ${bdc(n.category)}">${e(catLabel(n.category))}</span>
    </div>
    ${n.content ? `<div class="n-body">${e(n.content)}</div>` : ''}
    ${linksHtml(n.links)}
    ${tagsHtml(n.tags)}
    <div class="n-foot">
      <div class="n-dates">
        <span>📅 ${fmt(n.createdAt)}</span>
        ${n.updatedAt && fmt(n.updatedAt) !== fmt(n.createdAt) ? `<span>✏️ ${fmt(n.updatedAt)}</span>` : ''}
        ${isT && n.deletedAt ? `<span style="color:var(--red)">🗑 ${fmt(n.deletedAt)}</span>` : ''}
      </div>
      <div class="n-acts">${actsBtns(n._id, isT)}</div>
    </div>
  </div>`;
}

// ─ List ─
function listHtml(n, isT) {
  const prev = (n.content||'').replace(/\n/g,' ').slice(0, 90);
  return `<div class="nl ${bcc(n.category)}" onclick="openDet('${n._id}',${isT})">
    <span class="nl-dot ${dcc(n.category)}"></span>
    <div class="nl-main">
      <div class="nl-title">${e(n.title||'제목 없음')}</div>
      ${prev ? `<div class="nl-prev">${e(prev)}</div>` : ''}
      ${(n.tags||[]).length ? `<div class="nl-tags">${(n.tags||[]).slice(0,4).map(t=>`<span class="nl-tag">#${e(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="nl-right">
      <span class="n-badge ${bdc(n.category)}" style="font-size:9px">${e(catLabel(n.category))}</span>
      <span class="nl-date">${fmt(n.createdAt)}</span>
      <div class="nl-acts">${actsBtns(n._id, isT)}</div>
    </div>
  </div>`;
}

// ─ Magazine ─
function magHtml(n, isT) {
  const ci = catColor(n.category);
  const emoji = ci !== null ? MAG_EMOJIS[ci] : '📝';
  return `<div class="nm ${bcc(n.category)}" onclick="openDet('${n._id}',${isT})">
    <div class="nm-head ${mbgc(n.category)}">${emoji}
      <div class="nm-bar" ${ci !== null ? `style="background:linear-gradient(90deg,var(--acc),transparent)"` : ''}></div>
    </div>
    <div class="nm-body">
      <div class="n-head">
        <div class="n-title">${e(n.title||'제목 없음')}</div>
        <span class="n-badge ${bdc(n.category)}">${e(catLabel(n.category))}</span>
      </div>
      ${n.content ? `<div class="n-body">${e(n.content)}</div>` : ''}
      ${linksHtml(n.links)}
      ${tagsHtml(n.tags)}
      <div class="n-foot">
        <div class="n-dates"><span>📅 ${fmt(n.createdAt)}</span></div>
        <div class="n-acts">${actsBtns(n._id, isT)}</div>
      </div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════
// Navigation
// ═══════════════════════════════════════
window.goNav = function(target) {
  nav = target;
  renderTitle();
  renderAll();
  if (window.innerWidth <= 768) closeMobileSb();
};

// ═══════════════════════════════════════
// View mode
// ═══════════════════════════════════════
window.setView = function(mode) {
  view = mode;
  ['grid','list','magazine'].forEach(m =>
    document.getElementById(`vb-${m}`).classList.toggle('on', m === mode)
  );
  renderNotes();
};

// ═══════════════════════════════════════
// Sidebar toggle
// ═══════════════════════════════════════
let sbCollapsed = false;

window.toggleSidebar = function() {
  const sb   = document.getElementById('sidebar');
  const main = document.getElementById('main');
  if (window.innerWidth <= 768) {
    // Mobile: overlay mode
    sb.classList.toggle('sb-open');
    document.getElementById('sb-overlay').classList.toggle('on', sb.classList.contains('sb-open'));
  } else {
    // Desktop: push mode
    sbCollapsed = !sbCollapsed;
    sb.classList.toggle('hidden-sb', sbCollapsed);
    main.classList.toggle('full', sbCollapsed);
  }
};
window.closeMobileSb = function() {
  document.getElementById('sidebar').classList.remove('sb-open');
  document.getElementById('sb-overlay').classList.remove('on');
};

// ═══════════════════════════════════════
// EDIT MODAL
// ═══════════════════════════════════════
window.openAdd = function() {
  editId = null; eTags = []; eLinks = [];
  document.getElementById('edit-title-lbl').textContent = '새 메모';
  document.getElementById('e-title').value   = '';
  document.getElementById('e-content').value = '';
  fillCatSelect();
  // pre-select category if in cat nav
  if (nav.startsWith('cat:')) document.getElementById('e-cat').value = nav.slice(4);
  renderTagPre();
  renderLinkRows();
  document.getElementById('edit-overlay').classList.add('on');
  setTimeout(() => document.getElementById('e-title').focus(), 80);
};

window.openEdit = function(id) {
  const n = notes.find(x => x._id === id);
  if (!n) return;
  editId = id; eTags = [...(n.tags||[])]; eLinks = (n.links||[]).map(l => ({...l}));
  document.getElementById('edit-title-lbl').textContent = '메모 수정';
  document.getElementById('e-title').value   = n.title   || '';
  document.getElementById('e-content').value = n.content || '';
  fillCatSelect();
  document.getElementById('e-cat').value = n.category || '';
  renderTagPre();
  renderLinkRows();
  document.getElementById('edit-overlay').classList.add('on');
  closeDet();
};

window.closeEdit = function() { document.getElementById('edit-overlay').classList.remove('on'); };
window.closeEditIfBg = function(ev) { if (ev.target.id === 'edit-overlay') closeEdit(); };

window.saveNote = async function() {
  const title    = document.getElementById('e-title').value.trim();
  const content  = document.getElementById('e-content').value.trim();
  const category = document.getElementById('e-cat').value;
  if (!title) { showToast('제목을 입력해주세요.', 'wrn'); document.getElementById('e-title').focus(); return; }
  const allTags = [...new Set([...eTags, ...extractTags(content)])];
  const data    = { title, content, category, tags: allTags, links: eLinks.filter(l => l?.url) };
  try {
    if (editId) { await updateNoteDoc(editId, data); showToast('수정되었습니다. ✅'); }
    else        { await createNote(data);             showToast('저장되었습니다. ✅'); }
    closeEdit();
    renderAll();
  } catch(err) { showToast('저장 실패: ' + err.message, 'err'); }
};

// Content → auto-tag
document.getElementById('e-content').addEventListener('input', function() {
  const tags = extractTags(this.value);
  tags.forEach(t => { if (!eTags.includes(t)) eTags.push(t); });
  renderTagPre();
});

// ─ Link management ─
window.addLink = function() {
  eLinks.push({ label: '', url: '' });
  renderLinkRows();
  // focus the new URL input
  setTimeout(() => {
    const rows = document.querySelectorAll('.link-row-url');
    if (rows.length) rows[rows.length-1].focus();
  }, 50);
};

function renderLinkRows() {
  const wrap = document.getElementById('link-rows');
  wrap.innerHTML = eLinks.map((l, i) => {
    const fav = l.url ? favicon(l.url) : '';
    return `<div class="link-row-wrap">
      ${fav ? `<img class="lr-fav" src="${e(fav)}" alt="" onerror="this.style.display='none'">` : '<span style="font-size:15px;flex-shrink:0">🔗</span>'}
      <input type="text"  placeholder="표시 이름 (선택)" value="${e(l.label)}" style="max-width:130px"
             oninput="eLinks[${i}].label=this.value">
      <span class="lr-sep">|</span>
      <input class="link-row-url" type="url" placeholder="https://..." value="${e(l.url)}"
             oninput="eLinks[${i}].url=this.value;debounceFav(${i})">
      <button class="lr-del" onclick="removeLink(${i})">✕</button>
    </div>`;
  }).join('');
}

let favTimer;
window.debounceFav = function(i) {
  clearTimeout(favTimer);
  favTimer = setTimeout(() => renderLinkRows(), 900);
};
window.removeLink = function(i) { eLinks.splice(i, 1); renderLinkRows(); };

// ─ Tag management ─
function renderTagPre() {
  const el = document.getElementById('tag-pre');
  if (!eTags.length) {
    el.innerHTML = `<span style="font-size:11px;color:var(--text3)">내용에 #태그를 입력하면 자동으로 표시됩니다</span>`;
    return;
  }
  el.innerHTML = eTags.map((t, i) =>
    `<span class="tag-chip">#${e(t)} <span class="tag-del" onclick="removeTag(${i})">✕</span></span>`
  ).join('');
}
window.removeTag = function(i) { eTags.splice(i, 1); renderTagPre(); };

// ═══════════════════════════════════════
// DETAIL MODAL
// ═══════════════════════════════════════
window.openDet = function(id, isT = false) {
  const pool = isT ? trashed : notes;
  const n    = pool.find(x => x._id === id);
  if (!n) return;

  document.getElementById('det-title').textContent = n.title || '제목 없음';

  const linkCards = (n.links||[]).filter(l => l?.url).map(l => {
    const fav = favicon(l.url);
    return `<a class="det-link" href="${e(l.url)}" target="_blank" rel="noopener">
      ${fav ? `<img src="${e(fav)}" alt="" onerror="this.style.display='none'">` : '🔗'}
      <div class="det-link-info">
        <div class="det-link-name">${e(l.label || domain(l.url))}</div>
        <div class="det-link-url">${e(domain(l.url))}</div>
      </div>
    </a>`;
  }).join('');

  document.getElementById('det-body').innerHTML = `
    <span class="n-badge ${bdc(n.category)}" style="width:fit-content">${e(catLabel(n.category))}</span>
    ${n.content ? `<div class="det-content">${e(n.content)}</div>` : ''}
    ${linkCards ? `<div style="display:flex;flex-wrap:wrap;gap:8px">${linkCards}</div>` : ''}
    ${tagsHtml(n.tags)}
    <div class="det-meta">
      <span>📅 작성: ${fmt(n.createdAt)}</span>
      <span>✏️ 수정: ${fmt(n.updatedAt)}</span>
      ${isT && n.deletedAt ? `<span style="color:var(--red)">🗑 삭제: ${fmt(n.deletedAt)}</span>` : ''}
    </div>`;

  document.getElementById('det-foot').innerHTML = isT
    ? `<button class="btn btn-g"   onclick="closeDet()">닫기</button>
       <button class="btn btn-g"   style="color:var(--green);border-color:rgba(0,200,150,.3)" onclick="doRestore('${id}')">🔄 복원</button>
       <button class="btn btn-d"   onclick="doHardDel('${id}')">🗑 완전삭제</button>`
    : `<button class="btn btn-g"   onclick="closeDet()">닫기</button>
       <button class="btn btn-g"   onclick="doTrash('${id}')">🗑 삭제</button>
       <button class="btn btn-p"   onclick="openEdit('${id}')">✏️ 수정</button>`;

  document.getElementById('det-overlay').classList.add('on');
};
window.closeDet = function() { document.getElementById('det-overlay').classList.remove('on'); };
window.closeDetIfBg = function(ev) { if (ev.target.id === 'det-overlay') closeDet(); };

// ═══════════════════════════════════════
// Search / Sort
// ═══════════════════════════════════════
document.getElementById('search-inp').addEventListener('input', () => { renderNotes(); renderStats(); });
document.getElementById('sort-sel').addEventListener('change', () => renderNotes());

// ═══════════════════════════════════════
// Utilities
// ═══════════════════════════════════════
function fmt(d) {
  if (!d) return '-';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '-';
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}.${p(dt.getMonth()+1)}.${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

// HTML escape
function e(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
window.e = e; // expose for inline HTML

function setSyncStatus(state) {
  const el = document.getElementById('sync-badge');
  if      (state==='ok')  { el.textContent='🔥 연결됨';    el.className='sync-badge s-ok'; }
  else if (state==='ing') { el.textContent='⏳ 동기화 중...'; el.className='sync-badge s-ing'; }
  else                    { el.textContent='❌ 오류';       el.className='sync-badge s-err'; }
}

function showToast(msg, type='ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ═══════════════════════════════════════
// Google Auth
// ═══════════════════════════════════════
window.googleLogin = async function() {
  try { await signInWithPopup(auth, gProvider); }
  catch(err) { if (err.code !== 'auth/popup-closed-by-user') alert('로그인 실패: ' + err.message); }
};
window.googleLogout = async function() {
  if (confirm('로그아웃 하시겠습니까?')) await signOut(auth);
};

// ═══════════════════════════════════════
// Auth state → init
// ═══════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  const loginEl   = document.getElementById('login-screen');
  const loadingEl = document.getElementById('loading-screen');

  if (user) {
    me = user;
    loginEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');

    // User UI
    document.getElementById('user-chip').style.display  = 'flex';
    document.getElementById('logout-btn').style.display = 'block';
    document.getElementById('u-name').textContent = user.displayName || user.email || '';
    const av = document.getElementById('u-avatar');
    const fb = document.getElementById('u-fallback');
    if (user.photoURL) { av.src = user.photoURL; av.style.display = 'block'; fb.style.display = 'none'; }
    else { fb.textContent = (user.displayName || user.email || '?')[0].toUpperCase(); }

    await loadAll();
    loadingEl.classList.add('hidden');
    renderTitle();
    renderAll();
  } else {
    me = null; notes = []; trashed = []; cats = [];
    loadingEl.classList.add('hidden');
    loginEl.classList.remove('hidden');
    document.getElementById('user-chip').style.display  = 'none';
    document.getElementById('logout-btn').style.display = 'none';
  }
});
