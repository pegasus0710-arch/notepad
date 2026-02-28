// ══════════════════════════════════════════════════════
// Firebase SDK imports
// ══════════════════════════════════════════════════════
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getFirestore, collection, doc,
  getDocs, addDoc, deleteDoc, setDoc,
  serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-firestore.js";
import {
  getAuth, GoogleAuthProvider,
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js";

// ══════════════════════════════════════════════════════
// Firebase 설정 (본인 프로젝트 값)
// ══════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: "AIzaSyComDARleCbTfzB9LTdS211DSSHp1PXIPk",
  authDomain: "notepad-e6a66.firebaseapp.com",
  projectId: "notepad-e6a66",
  storageBucket: "notepad-e6a66.firebasestorage.app",
  messagingSenderId: "739275664534",
  appId: "1:739275664534:web:8368fdffb5d8f3d67da6b7",
  measurementId: "G-GN1FNHRGBE"
};

const app      = initializeApp(firebaseConfig);
const db       = getFirestore(app);
const auth     = getAuth(app);
const provider = new GoogleAuthProvider();

// ══════════════════════════════════════════════════════
// 앱 상태
// ══════════════════════════════════════════════════════
let me        = null;   // 로그인 유저
let notes     = [];     // 활성 메모
let trashed   = [];     // 휴지통 메모
let cats      = [];     // 카테고리 [{_id, name}]
let trashDays = 30;

let nav   = 'all';      // 'all' | 'trash' | 'cat:{id}'
let view  = 'grid';     // 'grid' | 'list' | 'magazine'

let editId = null;      // 수정 중인 메모 ID (null = 신규)
let eTags  = [];        // 편집 중 태그 목록
let eLinks = [];        // 편집 중 링크 목록 [{label, url}]

let sbCollapsed = false; // 사이드바 접힘 상태

// ══════════════════════════════════════════════════════
// Firestore 경로 헬퍼
// ══════════════════════════════════════════════════════
const colNotes = () => collection(db, 'users', me.uid, 'notes');
const colCats  = () => collection(db, 'users', me.uid, 'categories');
const docSett  = () => doc(db, 'users', me.uid, 'settings', 'main');

// ══════════════════════════════════════════════════════
// 데이터 로드
// ══════════════════════════════════════════════════════
async function loadAll() {
  setSyncStatus('ing');
  try {
    // 메모
    const ns = await getDocs(colNotes());
    const all = ns.docs.map(d => ({
      ...d.data(), _id: d.id,
      createdAt: toDate(d.data().createdAt),
      updatedAt: toDate(d.data().updatedAt),
      deletedAt: toDate(d.data().deletedAt),
    }));
    notes   = all.filter(n => !n.deleted);
    trashed = all.filter(n =>  n.deleted);

    // 카테고리
    const cs = await getDocs(colCats());
    cats = cs.docs.map(d => ({ ...d.data(), _id: d.id }));

    // 설정
    try {
      const ss = await getDocs(collection(db, 'users', me.uid, 'settings'));
      ss.forEach(d => {
        if (d.id === 'main' && d.data().trashDays != null)
          trashDays = Number(d.data().trashDays);
      });
      g('trash-period').value = String(trashDays);
    } catch (_) {}

    // 만료된 휴지통 자동 삭제
    await pruneTrash();
    setSyncStatus('ok');
  } catch (err) {
    console.error('loadAll error:', err);
    setSyncStatus('err');
    toast('데이터 로드 실패: ' + err.message, 'err');
  }
}

function toDate(v) {
  if (!v) return null;
  if (v?.toDate) return v.toDate();
  try { return new Date(v); } catch { return null; }
}

// ══════════════════════════════════════════════════════
// 휴지통 자동 삭제
// ══════════════════════════════════════════════════════
async function pruneTrash() {
  if (!trashDays) return;
  const cutoff = Date.now() - trashDays * 864e5;
  const expired = trashed.filter(n => n.deletedAt && n.deletedAt.getTime() < cutoff);
  if (!expired.length) return;
  const b = writeBatch(db);
  expired.forEach(n => b.delete(doc(colNotes(), n._id)));
  await b.commit();
  const ids = new Set(expired.map(n => n._id));
  trashed = trashed.filter(n => !ids.has(n._id));
}

// ══════════════════════════════════════════════════════
// 카테고리 헬퍼
// ══════════════════════════════════════════════════════
function catById(id) { return cats.find(c => c._id === id) || null; }
function catColorIdx(id) {
  const i = cats.findIndex(c => c._id === id);
  return i >= 0 ? i % 8 : -1;
}
function catLabel(id) { return catById(id)?.name || '카테고리없음'; }
const MAG_EMOJI = ['💼','🌿','💡','🔮','🌊','🌸','🍀','⭐'];

// ══════════════════════════════════════════════════════
// CSS 클래스 헬퍼
// ══════════════════════════════════════════════════════
function barCls(id)   { const i=catColorIdx(id); return i>=0?`bc${i}`:'bcX'; }
function dotCls(id)   { const i=catColorIdx(id); return i>=0?`dc${i}`:'dcX'; }
function badgeCls(id) { const i=catColorIdx(id); return i>=0?`bd${i}`:'bdX'; }
function magCls(id)   { const i=catColorIdx(id); return i>=0?`mb${i}`:'mbX'; }

// ══════════════════════════════════════════════════════
// 카테고리 CRUD
// ══════════════════════════════════════════════════════
async function addCat() {
  const inp  = g('new-cat-inp');
  const name = inp.value.trim();
  if (!name) { inp.focus(); return; }
  if (cats.find(c => c.name === name)) {
    toast(`'${name}' 카테고리가 이미 존재합니다.`, 'wrn');
    return;
  }
  try {
    const ref = await addDoc(colCats(), { name });
    cats.push({ _id: ref.id, name });
    inp.value = '';
    renderAll();
    toast(`'${name}' 카테고리 추가됨 ✅`);
  } catch (err) { toast('추가 실패: ' + err.message, 'err'); }
}

async function deleteCat(id) {
  const cat = catById(id);
  if (!cat) return;
  if (!confirm(`'${cat.name}' 카테고리를 삭제하시겠습니까?\n해당 카테고리 메모는 '카테고리없음'으로 변경됩니다.`)) return;
  try {
    const b = writeBatch(db);
    b.delete(doc(colCats(), id));
    notes.filter(n => n.category === id).forEach(n => {
      b.set(doc(colNotes(), n._id), { category: '', updatedAt: serverTimestamp() }, { merge: true });
      n.category = '';
    });
    await b.commit();
    cats = cats.filter(c => c._id !== id);
    if (nav === `cat:${id}`) nav = 'all';
    renderAll();
    toast(`'${cat.name}' 삭제됨`);
  } catch (err) { toast('삭제 실패: ' + err.message, 'err'); }
}

// ══════════════════════════════════════════════════════
// 메모 CRUD
// ══════════════════════════════════════════════════════
async function createNote(data) {
  const ref = await addDoc(colNotes(), {
    ...data, deleted: false,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  const now = new Date();
  notes.push({ ...data, deleted: false, _id: ref.id, createdAt: now, updatedAt: now });
}

async function updateNote(id, data) {
  await setDoc(doc(colNotes(), id), { ...data, updatedAt: serverTimestamp() }, { merge: true });
  const i = notes.findIndex(n => n._id === id);
  if (i >= 0) notes[i] = { ...notes[i], ...data, updatedAt: new Date() };
}

async function moveToTrash(id) {
  await setDoc(doc(colNotes(), id), { deleted: true, deletedAt: serverTimestamp() }, { merge: true });
  const n = notes.find(x => x._id === id);
  if (n) {
    n.deleted = true; n.deletedAt = new Date();
    notes = notes.filter(x => x._id !== id);
    trashed.push(n);
  }
}

async function restoreNote(id) {
  await setDoc(doc(colNotes(), id), { deleted: false, deletedAt: null }, { merge: true });
  const n = trashed.find(x => x._id === id);
  if (n) {
    n.deleted = false; n.deletedAt = null;
    trashed = trashed.filter(x => x._id !== id);
    notes.push(n);
  }
}

async function hardDelete(id) {
  await deleteDoc(doc(colNotes(), id));
  trashed = trashed.filter(x => x._id !== id);
}

async function emptyTrash() {
  if (!trashed.length) { toast('휴지통이 비어있습니다.', 'wrn'); return; }
  if (!confirm(`휴지통의 메모 ${trashed.length}개를 모두 영구 삭제할까요?`)) return;
  try {
    const b = writeBatch(db);
    trashed.forEach(n => b.delete(doc(colNotes(), n._id)));
    await b.commit();
    trashed = [];
    renderAll();
    toast('휴지통을 비웠습니다.');
  } catch (err) { toast('오류: ' + err.message, 'err'); }
}

async function saveTrashPeriod() {
  trashDays = parseInt(g('trash-period').value);
  await setDoc(docSett(), { trashDays }, { merge: true });
  toast('설정 저장됨 ✅');
}

// ══════════════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════════════
function g(id) { return document.getElementById(id); }

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmt(d) {
  if (!d) return '-';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '-';
  const p = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}.${p(dt.getMonth()+1)}.${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function favicon(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`; }
  catch { return ''; }
}

function domain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url.slice(0, 30); }
}

function extractTags(text) {
  return [...new Set((text.match(/#[\w가-힣]+/g) || []).map(t => t.slice(1)))];
}

function setSyncStatus(state) {
  const el = g('sync-badge');
  if (!el) return;
  if      (state === 'ok')  { el.textContent = '🔥 연결됨';     el.className = 'sbadge s-ok'; }
  else if (state === 'ing') { el.textContent = '⏳ 동기화 중...'; el.className = 'sbadge s-ing'; }
  else                      { el.textContent = '❌ 오류';        el.className = 'sbadge s-err'; }
}

function toast(msg, type = 'ok') {
  const el = g('toast');
  el.textContent = msg;
  el.className = `${type} show`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

// ══════════════════════════════════════════════════════
// 필터 & 정렬
// ══════════════════════════════════════════════════════
function getFiltered() {
  const q    = (g('search-inp')?.value || '').trim().toLowerCase();
  const sort = g('sort-sel')?.value || 'cd';
  const isT  = nav === 'trash';
  let list   = isT ? [...trashed] : [...notes];

  if (!isT && nav.startsWith('cat:')) {
    const cid = nav.slice(4);
    list = list.filter(n => n.category === cid);
  }
  if (q) {
    list = list.filter(n =>
      (n.title   || '').toLowerCase().includes(q) ||
      (n.content || '').toLowerCase().includes(q) ||
      (n.tags    || []).some(t => t.toLowerCase().includes(q)) ||
      catLabel(n.category).toLowerCase().includes(q)
    );
  }
  const key = (sort === 'cd' || sort === 'ca') ? 'createdAt' : 'updatedAt';
  const asc = (sort === 'ca' || sort === 'ma');
  list.sort((a, b) => {
    const at = new Date(a[key] || 0), bt = new Date(b[key] || 0);
    return asc ? at - bt : bt - at;
  });
  return list;
}

// ══════════════════════════════════════════════════════
// 렌더링
// ══════════════════════════════════════════════════════
function renderAll() {
  renderSidebar();
  renderNotes();
  renderStats();
  fillCatSelect();
}

function renderTitle() {
  const el = g('page-hd');
  if      (nav === 'all')             el.textContent = '📝 전체 메모';
  else if (nav === 'trash')           el.textContent = '🗑️ 휴지통';
  else if (nav.startsWith('cat:')) {
    const c = catById(nav.slice(4));
    el.textContent = c ? `🗂️ ${c.name}` : '📝 메모';
  }
}

function renderSidebar() {
  // 카운트
  g('cnt-all').textContent = notes.length;
  const tc = g('cnt-trash');
  if (trashed.length) { tc.textContent = trashed.length; tc.classList.remove('hidden'); }
  else                { tc.classList.add('hidden'); }

  // 네비 active
  g('nav-all').classList.toggle('on', nav === 'all');
  g('nav-trash').classList.toggle('on', nav === 'trash');

  // 휴지통 설정 패널
  g('trash-cfg').classList.toggle('hidden', nav !== 'trash');

  // 카테고리 목록
  const wrap = g('cat-rows');
  if (!cats.length) {
    wrap.innerHTML = '<div style="font-size:11px;color:var(--t3);padding:4px 10px 8px">카테고리 없음</div>';
    return;
  }
  wrap.innerHTML = cats.map((c, i) => {
    const ci  = i % 8;
    const cnt = notes.filter(n => n.category === c._id).length;
    const on  = nav === `cat:${c._id}`;
    return `<div class="crow${on?' on':''}" data-nav="cat:${esc(c._id)}">
      <span class="cdot dc${ci}"></span>
      <span class="cname">${esc(c.name)}</span>
      <span class="ccnt">${cnt}</span>
      <button class="cdel" data-delcat="${esc(c._id)}" title="삭제">✕</button>
    </div>`;
  }).join('');

  // 카테고리 행 이벤트 (위임)
  wrap.querySelectorAll('.crow').forEach(el => {
    el.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-delcat]');
      if (delBtn) {
        e.stopPropagation();
        deleteCat(delBtn.dataset.delcat);
        return;
      }
      goNav(el.dataset.nav);
    });
  });
}

function renderStats() {
  const list = getFiltered();
  g('page-stats').innerHTML =
    `<span>표시 <strong>${list.length}</strong>개</span>` +
    `<span>전체 <strong>${notes.length}</strong>개</span>` +
    `<span>휴지통 <strong>${trashed.length}</strong>개</span>`;
}

function fillCatSelect() {
  const sel = g('e-cat');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">카테고리없음</option>' +
    cats.map(c => `<option value="${esc(c._id)}">${esc(c.name)}</option>`).join('');
  if (prev) sel.value = prev;
}

// ── 메모 렌더 ──
function renderNotes() {
  const wrap = g('notes-wrap');
  wrap.className = `v${view}`;
  const list = getFiltered();
  const isT  = nav === 'trash';
  const q    = (g('search-inp')?.value || '').trim();

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">
      <div class="empty-icon">${isT ? '🗑️' : q ? '🔍' : '📭'}</div>
      <p>${isT ? '휴지통이 비어있습니다.' : q ? `"${esc(q)}" 검색 결과 없음` : '메모가 없습니다. 새 메모를 작성해보세요!'}</p>
    </div>`;
    return;
  }

  const htmlFn = view === 'grid' ? cardHtml : view === 'list' ? listHtml : magHtml;
  wrap.innerHTML = list.map(n => htmlFn(n, isT)).join('');

  // 메모 클릭 이벤트 위임
  wrap.querySelectorAll('[data-note-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      const id  = el.dataset.noteId;
      const isT = el.dataset.trash === '1';
      // 수정 버튼
      if (e.target.closest('[data-edit]')) { openEdit(id); return; }
      // 삭제(휴지통으로) 버튼
      if (e.target.closest('[data-trash]')) { doTrash(id, isT); return; }
      // 복원 버튼
      if (e.target.closest('[data-restore]')) { doRestore(id); return; }
      // 완전삭제 버튼
      if (e.target.closest('[data-hardel]')) { doHardDel(id); return; }
      // 링크 클릭은 상세 열지 않음
      if (e.target.closest('a')) return;
      // 상세보기
      openDet(id, isT);
    });
  });
}

// ── HTML 조각 ──
function linksHtml(links) {
  const valid = (links || []).filter(l => l?.url);
  if (!valid.length) return '';
  return `<div class="nlinks">${valid.map(l => {
    const fav = favicon(l.url);
    return `<a class="lchip" href="${esc(l.url)}" target="_blank" rel="noopener">
      ${fav ? `<img class="lcfav" src="${esc(fav)}" alt="" onerror="this.style.display='none'">` : '🔗'}
      <span class="lclbl">${esc(l.label || domain(l.url))}</span>
    </a>`;
  }).join('')}</div>`;
}

function tagsHtml(tags) {
  if (!(tags || []).length) return '';
  return `<div class="ntags">${tags.map(t => `<span class="ntag">#${esc(t)}</span>`).join('')}</div>`;
}

function actBtns(id, isT) {
  if (isT) return `
    <button class="na grn" data-restore>복원</button>
    <button class="na del" data-hardel>완전삭제</button>`;
  return `
    <button class="na"     data-edit>수정</button>
    <button class="na del" data-trash>삭제</button>`;
}

function cardHtml(n, isT) {
  return `<div class="nc ${barCls(n.category)}" data-note-id="${n._id}" data-trash="${isT?'1':'0'}">
    <div class="nhead">
      <div class="ntitle">${esc(n.title || '제목 없음')}</div>
      <span class="nbadge ${badgeCls(n.category)}">${esc(catLabel(n.category))}</span>
    </div>
    ${n.content ? `<div class="nbody">${esc(n.content)}</div>` : ''}
    ${linksHtml(n.links)}
    ${tagsHtml(n.tags)}
    <div class="nfoot">
      <div class="ndates">
        <span>📅 ${fmt(n.createdAt)}</span>
        ${n.updatedAt && fmt(n.updatedAt) !== fmt(n.createdAt) ? `<span>✏️ ${fmt(n.updatedAt)}</span>` : ''}
        ${isT && n.deletedAt ? `<span style="color:var(--red)">🗑 ${fmt(n.deletedAt)}</span>` : ''}
      </div>
      <div class="nacts">${actBtns(n._id, isT)}</div>
    </div>
  </div>`;
}

function listHtml(n, isT) {
  const prev = (n.content || '').replace(/\n/g, ' ').slice(0, 90);
  return `<div class="nl ${barCls(n.category)}" data-note-id="${n._id}" data-trash="${isT?'1':'0'}">
    <span class="nldot ${dotCls(n.category)}"></span>
    <div class="nlmain">
      <div class="nltitle">${esc(n.title || '제목 없음')}</div>
      ${prev ? `<div class="nlprev">${esc(prev)}</div>` : ''}
      ${(n.tags || []).length ? `<div class="nltags">${n.tags.slice(0,4).map(t=>`<span class="nltag">#${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="nlright">
      <span class="nbadge ${badgeCls(n.category)}" style="font-size:9px">${esc(catLabel(n.category))}</span>
      <span class="nldate">${fmt(n.createdAt)}</span>
      <div class="nlacts">${actBtns(n._id, isT)}</div>
    </div>
  </div>`;
}

function magHtml(n, isT) {
  const ci    = catColorIdx(n.category);
  const emoji = ci >= 0 ? MAG_EMOJI[ci] : '📝';
  return `<div class="nm ${barCls(n.category)}" data-note-id="${n._id}" data-trash="${isT?'1':'0'}">
    <div class="nmhd ${magCls(n.category)}">${emoji}
      <div class="nmbar"${ci>=0?' style="background:linear-gradient(90deg,var(--acc),transparent)"':''}></div>
    </div>
    <div class="nmbody">
      <div class="nhead">
        <div class="ntitle">${esc(n.title || '제목 없음')}</div>
        <span class="nbadge ${badgeCls(n.category)}">${esc(catLabel(n.category))}</span>
      </div>
      ${n.content ? `<div class="nbody">${esc(n.content)}</div>` : ''}
      ${linksHtml(n.links)}
      ${tagsHtml(n.tags)}
      <div class="nfoot">
        <div class="ndates"><span>📅 ${fmt(n.createdAt)}</span></div>
        <div class="nacts">${actBtns(n._id, isT)}</div>
      </div>
    </div>
  </div>`;
}

// ══════════════════════════════════════════════════════
// 액션
// ══════════════════════════════════════════════════════
async function doTrash(id, isT) {
  if (isT) return; // 이미 휴지통이면 무시
  const n = notes.find(x => x._id === id);
  if (!confirm(`"${n?.title || '이 메모'}"를 휴지통으로 이동할까요?`)) return;
  try { await moveToTrash(id); closeDet(); renderAll(); toast('휴지통으로 이동했습니다.'); }
  catch (err) { toast('오류: ' + err.message, 'err'); }
}

async function doRestore(id) {
  try { await restoreNote(id); closeDet(); renderAll(); toast('복원되었습니다. ✅'); }
  catch (err) { toast('오류: ' + err.message, 'err'); }
}

async function doHardDel(id) {
  if (!confirm('완전히 삭제합니다. 복구할 수 없습니다.')) return;
  try { await hardDelete(id); closeDet(); renderAll(); toast('영구 삭제됨'); }
  catch (err) { toast('오류: ' + err.message, 'err'); }
}

function goNav(target) {
  nav = target;
  renderTitle();
  renderAll();
  if (window.innerWidth <= 768) closeMobileSb();
}

// ══════════════════════════════════════════════════════
// 사이드바 토글
// ══════════════════════════════════════════════════════
function toggleSidebar() {
  const sb   = g('sidebar');
  const main = g('main');
  if (window.innerWidth <= 768) {
    sb.classList.toggle('sb-open');
    g('sbov').classList.toggle('on', sb.classList.contains('sb-open'));
  } else {
    sbCollapsed = !sbCollapsed;
    sb.classList.toggle('sb-hide', sbCollapsed);
    main.classList.toggle('full', sbCollapsed);
  }
}

function closeMobileSb() {
  g('sidebar').classList.remove('sb-open');
  g('sbov').classList.remove('on');
}

// ══════════════════════════════════════════════════════
// 뷰 변경
// ══════════════════════════════════════════════════════
function setView(mode) {
  view = mode;
  ['grid', 'list', 'magazine'].forEach(m =>
    g(`vb-${m}`).classList.toggle('on', m === mode)
  );
  renderNotes();
}

// ══════════════════════════════════════════════════════
// 편집 모달
// ══════════════════════════════════════════════════════
function openAdd() {
  editId = null; eTags = []; eLinks = [];
  g('edit-modal-title').textContent = '새 메모';
  g('e-title').value   = '';
  g('e-content').value = '';
  fillCatSelect();
  if (nav.startsWith('cat:')) g('e-cat').value = nav.slice(4);
  else g('e-cat').value = '';
  renderTagPre();
  renderLinkRows();
  g('edit-ov').classList.add('on');
  setTimeout(() => g('e-title').focus(), 80);
}

function openEdit(id) {
  const n = notes.find(x => x._id === id);
  if (!n) return;
  editId = id; eTags = [...(n.tags || [])]; eLinks = (n.links || []).map(l => ({...l}));
  g('edit-modal-title').textContent = '메모 수정';
  g('e-title').value   = n.title   || '';
  g('e-content').value = n.content || '';
  fillCatSelect();
  g('e-cat').value = n.category || '';
  renderTagPre();
  renderLinkRows();
  g('edit-ov').classList.add('on');
  closeDet();
}

function closeEdit() { g('edit-ov').classList.remove('on'); }

async function saveNote() {
  const title    = g('e-title').value.trim();
  const content  = g('e-content').value.trim();
  const category = g('e-cat').value;
  if (!title) { toast('제목을 입력해주세요.', 'wrn'); g('e-title').focus(); return; }
  const allTags = [...new Set([...eTags, ...extractTags(content)])];
  const data    = { title, content, category, tags: allTags, links: eLinks.filter(l => l?.url) };
  try {
    if (editId) { await updateNote(editId, data); toast('수정되었습니다. ✅'); }
    else        { await createNote(data);          toast('저장되었습니다. ✅'); }
    closeEdit();
    renderAll();
  } catch (err) { toast('저장 실패: ' + err.message, 'err'); }
}

// ─ 링크 ─
function addLink() {
  eLinks.push({ label: '', url: '' });
  renderLinkRows();
  setTimeout(() => {
    const ins = document.querySelectorAll('#link-rows .lr-url');
    if (ins.length) ins[ins.length - 1].focus();
  }, 50);
}

function renderLinkRows() {
  const wrap = g('link-rows');
  wrap.innerHTML = eLinks.map((l, i) => {
    const fav = l.url ? favicon(l.url) : '';
    return `<div class="lrwrap">
      ${fav
        ? `<img class="lrfav" src="${esc(fav)}" alt="" onerror="this.style.display='none'">`
        : '<span style="font-size:15px;flex-shrink:0">🔗</span>'}
      <input class="lrinp" type="text" placeholder="표시 이름 (선택)" value="${esc(l.label)}"
             data-li="${i}" data-lf="label" style="max-width:120px">
      <span class="lrsep">|</span>
      <input class="lrinp lr-url" type="url" placeholder="https://..." value="${esc(l.url)}"
             data-li="${i}" data-lf="url">
      <button class="lrdel" data-li="${i}" type="button">✕</button>
    </div>`;
  }).join('');

  // 이벤트
  wrap.querySelectorAll('.lrinp').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = parseInt(inp.dataset.li);
      const f = inp.dataset.lf;
      eLinks[i][f] = inp.value;
      if (f === 'url') { clearTimeout(inp._ft); inp._ft = setTimeout(() => renderLinkRows(), 900); }
    });
  });
  wrap.querySelectorAll('.lrdel').forEach(btn => {
    btn.addEventListener('click', () => {
      eLinks.splice(parseInt(btn.dataset.li), 1);
      renderLinkRows();
    });
  });
}

// ─ 태그 ─
function renderTagPre() {
  const el = g('tag-pre');
  if (!eTags.length) {
    el.innerHTML = '<span style="font-size:11px;color:var(--t3)">내용에 #태그를 입력하면 자동으로 표시됩니다</span>';
    return;
  }
  el.innerHTML = eTags.map((t, i) =>
    `<span class="tagchip">#${esc(t)}
      <button class="tagdel" data-ti="${i}" type="button">✕</button>
    </span>`
  ).join('');
  el.querySelectorAll('.tagdel').forEach(btn => {
    btn.addEventListener('click', () => {
      eTags.splice(parseInt(btn.dataset.ti), 1);
      renderTagPre();
    });
  });
}

// ══════════════════════════════════════════════════════
// 상세보기 모달
// ══════════════════════════════════════════════════════
function openDet(id, isT) {
  const pool = isT ? trashed : notes;
  const n    = pool.find(x => x._id === id);
  if (!n) return;

  g('det-title').textContent = n.title || '제목 없음';

  const linkCards = (n.links || []).filter(l => l?.url).map(l => {
    const fav = favicon(l.url);
    return `<a class="detlink" href="${esc(l.url)}" target="_blank" rel="noopener">
      ${fav ? `<img src="${esc(fav)}" alt="" onerror="this.style.display='none'">` : '🔗'}
      <div class="detlinfo">
        <div class="detlname">${esc(l.label || domain(l.url))}</div>
        <div class="detlurl">${esc(domain(l.url))}</div>
      </div>
    </a>`;
  }).join('');

  g('det-body').innerHTML = `
    <span class="nbadge ${badgeCls(n.category)}" style="width:fit-content">${esc(catLabel(n.category))}</span>
    ${n.content ? `<div class="detcontent">${esc(n.content)}</div>` : ''}
    ${linkCards ? `<div class="detlinks">${linkCards}</div>` : ''}
    ${tagsHtml(n.tags)}
    <div class="detmeta">
      <span>📅 작성: ${fmt(n.createdAt)}</span>
      <span>✏️ 수정: ${fmt(n.updatedAt)}</span>
      ${isT && n.deletedAt ? `<span style="color:var(--red)">🗑 삭제: ${fmt(n.deletedAt)}</span>` : ''}
    </div>`;

  const foot = g('det-foot');
  foot.innerHTML = '';

  const closeB = document.createElement('button');
  closeB.className = 'btn btng'; closeB.textContent = '닫기';
  closeB.addEventListener('click', closeDet);
  foot.appendChild(closeB);

  if (isT) {
    const restB = document.createElement('button');
    restB.className = 'btn btng';
    restB.style.cssText = 'color:var(--green);border-color:rgba(0,200,150,.3)';
    restB.textContent = '🔄 복원';
    restB.addEventListener('click', () => doRestore(id));
    foot.appendChild(restB);

    const hardB = document.createElement('button');
    hardB.className = 'btn btnd'; hardB.textContent = '🗑 완전삭제';
    hardB.addEventListener('click', () => doHardDel(id));
    foot.appendChild(hardB);
  } else {
    const trashB = document.createElement('button');
    trashB.className = 'btn btng'; trashB.textContent = '🗑 삭제';
    trashB.addEventListener('click', () => doTrash(id, false));
    foot.appendChild(trashB);

    const editB = document.createElement('button');
    editB.className = 'btn btnp'; editB.textContent = '✏️ 수정';
    editB.addEventListener('click', () => openEdit(id));
    foot.appendChild(editB);
  }

  g('det-ov').classList.add('on');
}

function closeDet() { g('det-ov').classList.remove('on'); }

// ══════════════════════════════════════════════════════
// Auth
// ══════════════════════════════════════════════════════
async function googleLogin() {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code !== 'auth/popup-closed-by-user') {
      alert('로그인 실패: ' + err.message);
    }
  }
}

async function googleLogout() {
  if (confirm('로그아웃 하시겠습니까?')) {
    await signOut(auth);
  }
}

// ══════════════════════════════════════════════════════
// 이벤트 바인딩 (addEventListener - inline handler 없음)
// ══════════════════════════════════════════════════════
function bindEvents() {
  // 로그인
  g('google-login-btn').addEventListener('click', googleLogin);

  // 로그아웃
  g('logout-btn').addEventListener('click', googleLogout);

  // 사이드바 토글
  g('menu-btn').addEventListener('click', toggleSidebar);

  // 모바일 사이드바 오버레이
  g('sbov').addEventListener('click', closeMobileSb);

  // 네비게이션
  g('nav-all').addEventListener('click',   () => goNav('all'));
  g('nav-trash').addEventListener('click', () => goNav('trash'));

  // 카테고리 추가
  g('add-cat-btn').addEventListener('click', addCat);
  g('new-cat-inp').addEventListener('keydown', e => { if (e.key === 'Enter') addCat(); });

  // 휴지통 설정
  g('trash-period').addEventListener('change', saveTrashPeriod);
  g('empty-trash-btn').addEventListener('click', emptyTrash);

  // 새 메모
  g('new-btn').addEventListener('click', openAdd);

  // 뷰 전환
  g('vb-grid').addEventListener('click',     () => setView('grid'));
  g('vb-list').addEventListener('click',     () => setView('list'));
  g('vb-magazine').addEventListener('click', () => setView('magazine'));

  // 정렬
  g('sort-sel').addEventListener('change', () => renderNotes());

  // 검색
  g('search-inp').addEventListener('input', () => { renderNotes(); renderStats(); });

  // 편집 모달
  g('edit-close-btn').addEventListener('click',  closeEdit);
  g('edit-cancel-btn').addEventListener('click', closeEdit);
  g('save-btn').addEventListener('click', saveNote);
  g('edit-ov').addEventListener('click', e => { if (e.target === g('edit-ov')) closeEdit(); });

  // 내용 입력 시 태그 자동 추출
  g('e-content').addEventListener('input', function() {
    const newTags = extractTags(this.value);
    newTags.forEach(t => { if (!eTags.includes(t)) eTags.push(t); });
    renderTagPre();
  });

  // 링크 추가
  g('add-link-btn').addEventListener('click', addLink);

  // 상세 모달
  g('det-close-btn').addEventListener('click', closeDet);
  g('det-ov').addEventListener('click', e => { if (e.target === g('det-ov')) closeDet(); });
}

// ══════════════════════════════════════════════════════
// 인증 상태 감지 → 진입점
// ══════════════════════════════════════════════════════
onAuthStateChanged(auth, async (user) => {
  if (user) {
    me = user;
    g('login-screen').classList.add('hidden');
    g('loading-screen').classList.remove('hidden');

    // 사용자 UI
    g('user-chip').classList.remove('hidden');
    g('logout-btn').classList.remove('hidden');
    g('u-name').textContent = user.displayName || user.email || '';
    if (user.photoURL) {
      g('u-avatar').src = user.photoURL;
      g('u-avatar').classList.remove('hidden');
      g('u-fallback').classList.add('hidden');
    } else {
      g('u-fallback').textContent = (user.displayName || user.email || '?')[0].toUpperCase();
      g('u-fallback').classList.remove('hidden');
      g('u-avatar').classList.add('hidden');
    }

    await loadAll();
    g('loading-screen').classList.add('hidden');
    renderTitle();
    renderAll();
  } else {
    // 로그아웃 상태
    me = null; notes = []; trashed = []; cats = [];
    g('login-screen').classList.remove('hidden');
    g('loading-screen').classList.add('hidden');
    g('user-chip').classList.add('hidden');
    g('logout-btn').classList.add('hidden');
  }
});

// DOM 준비 후 이벤트 바인딩
bindEvents();
