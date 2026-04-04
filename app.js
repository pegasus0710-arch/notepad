// ══════════════════════════════════════════════════════
// Firebase SDK imports
// ══════════════════════════════════════════════════════
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/11.0.1/firebase-app.js";
import {
  getFirestore, collection, doc,
  getDocs, addDoc, updateDoc, deleteDoc, setDoc,
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
  apiKey:            "AIzaSyComDARleCbTfzB9LTdS211DSSHp1PXIPk",
  authDomain:        "notepad-e6a66.firebaseapp.com",
  projectId:         "notepad-e6a66",
  storageBucket:     "notepad-e6a66.firebasestorage.app",
  messagingSenderId: "739275664534",
  appId:             "1:739275664534:web:8368fdffb5d8f3d67da6b7",
  measurementId:     "G-GN1FNHRGBE"
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
let quotes    = [];     // 한줄명언 [{_id, text, author, createdAt}]
let trashDays = 30;

let nav   = 'all';      // 'all' | 'trash' | 'cat:{id}'
let view  = 'dash';     // 'grid'|'list'|'magazine'|'compact'|'timeline'|'kanban'|'dash'

// ── 필터 상태
let filterLink  = false;   // 링크있음 필터
let filterPeriod = '';     // 'week'|'month'|''
let filterTag   = '';      // 태그 필터 문자열

// ── 설정 상태
let perPage    = parseInt(localStorage.getItem('cfg_perPage') || '20');
let scrollMode = localStorage.getItem('cfg_scrollMode') || 'scroll'; // 'scroll'|'page'
let curPage    = 1;

let editId = null;      // 수정 중인 메모 ID (null = 신규)
let eTags  = [];        // 편집 중 태그 목록
let eLinks = [];        // 편집 중 링크 목록 [{label, url}]

let sbCollapsed = false; // 사이드바 접힘 상태
let tlGroup   = 'day';  // 'day'|'month'|'year'
let quillInst = null;  // Quill 인스턴스
const thumbCache = new Map();  // 링크 썸네일 캐시

// ══════════════════════════════════════════════════════
// Firestore 경로 헬퍼
// ══════════════════════════════════════════════════════
const colNotes  = () => collection(db, 'users', me.uid, 'notes');
const colCats   = () => collection(db, 'users', me.uid, 'categories');
const colQuotes = () => collection(db, 'users', me.uid, 'quotes');
const docSett  = () => doc(db, 'users', me.uid, 'settings', 'main');

// ══════════════════════════════════════════════════════
// 데이터 로드
// ══════════════════════════════════════════════════════
async function purgeLegacyThumbCache() {
  // 구버전 'thumb_' 키(btoa slice 방식) → 캐시 충돌 원인, 전체 삭제
  try {
    const toDelete = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('thumb_') && !k.startsWith('thumb2_')) toDelete.push(k);
    }
    toDelete.forEach(k => localStorage.removeItem(k));
    if (toDelete.length) console.log(`[썸네일] 오염된 캐시 ${toDelete.length}개 삭제`);
  } catch(_) {}
}

async function loadAll() {
  purgeLegacyThumbCache();
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

    // 한줄명언
    const qs = await getDocs(colQuotes());
    quotes = qs.docs.map(d => ({
      ...d.data(), _id: d.id,
      createdAt: toDate(d.data().createdAt),
      updatedAt: toDate(d.data().updatedAt),
    })).sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));

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
  const btn = g('add-cat-btn');
  btn.textContent = '...'; btn.disabled = true;
  try {
    const ref = await addDoc(colCats(), { name });
    cats.push({ _id: ref.id, name });
    inp.value = '';
    renderAll();
    toast(`'${name}' 카테고리 추가됨 ✅`);
  } catch (err) {
    console.error('addCat error:', err);
    toast('추가 실패: ' + err.message, 'err');
    alert('카테고리 추가 실패\n\n' + err.code + ': ' + err.message + '\n\nFirebase 보안 규칙을 확인하세요.');
  } finally {
    btn.textContent = '추가'; btn.disabled = false;
  }
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
  const customDate = data._customCreatedAt || null;
  const { _customCreatedAt, ...cleanData } = data;
  const ref = await addDoc(colNotes(), {
    ...cleanData, deleted: false,
    createdAt: customDate || serverTimestamp(),
    updatedAt: serverTimestamp()
  });
  if (customDate) {
    // serverTimestamp 대신 실제 Date 객체로 덮어쓰기
    await setDoc(doc(colNotes(), ref.id), { createdAt: customDate }, { merge: true });
  }
  const now = new Date();
  notes.push({ ...cleanData, deleted: false, _id: ref.id, createdAt: customDate || now, updatedAt: now });
}


async function toggleStar(id) {
  const n = notes.find(x => x._id === id);
  if (!n) return;
  n.starred = !n.starred;
  await setDoc(doc(colNotes(), id), { starred: n.starred }, { merge: true });
  renderAll();
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
  const days=['일','월','화','수','목','금','토'];
  return `${dt.getFullYear()}.${p(dt.getMonth()+1)}.${p(dt.getDate())}(${days[dt.getDay()]}) ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

function favicon(url) {
  try { return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`; }
  catch { return ''; }
}

function domain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return url.slice(0, 30); }
}

function isRich(s) { return typeof s === 'string' && s.trimStart().startsWith('<'); }
function stripHtml(s) {
  if (!isRich(s)) return s || '';
  const d = document.createElement('div'); d.innerHTML=s; return d.textContent||'';
}

function extractTags(text) {
  const plain = isRich(text) ? stripHtml(text) : (text || '');
  return [...new Set((plain.match(/#[\w가-힣]+/g) || []).map(t => t.slice(1)))];
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
  else if (!isT && nav === 'starred') { list = list.filter(n => n.starred); }
  else if (!isT && nav === 'uncat')   { list = list.filter(n => !n.category || !cats.find(c=>c._id===n.category)); }
  if (q) {
    list = list.filter(n =>
      (n.title   || '').toLowerCase().includes(q) ||
      (n.content || '').toLowerCase().includes(q) ||
      (n.tags    || []).some(t => t.toLowerCase().includes(q)) ||
      catLabel(n.category).toLowerCase().includes(q)
    );
  }
  // 추가 필터
  if (filterLink) list = list.filter(n => (n.links||[]).some(l=>l?.url));
  if (filterTag)  list = list.filter(n => (n.tags||[]).includes(filterTag));
  if (filterPeriod) {
    if (filterPeriod === 'today') {
      const todStr = new Date().toDateString();
      list = list.filter(n => n.createdAt && new Date(n.createdAt).toDateString() === todStr);
    } else {
      const now_ = Date.now();
      const cutoff = filterPeriod === 'week' ? now_ - 7*864e5 : now_ - 30*864e5;
      list = list.filter(n => n.createdAt && new Date(n.createdAt).getTime() >= cutoff);
    }
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
  renderChipBar();
  renderNotes();
  renderStats();
  fillCatSelect();
}

function renderTitle() {
  const el = g('page-hd');
  if      (nav === 'all')             el.textContent = '📝 전체 메모';
  else if (nav === 'quote')           el.textContent = '💬 한줄명언';
  else if (nav === 'trash')           el.textContent = '🗑️ 휴지통';
  else if (nav === 'starred')         el.textContent = '★ 즐겨찾기';
  else if (nav === 'uncat')           el.textContent = '📂 카테고리 없음';
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
  const _ns=g('nav-starred'); if(_ns){_ns.classList.toggle('on',nav==='starred');const sc=g('cnt-starred');if(sc)sc.textContent=notes.filter(n=>n.starred).length;}
  const _nu=g('nav-uncat');   if(_nu){_nu.classList.toggle('on',nav==='uncat');const uc=g('cnt-uncat');if(uc)uc.textContent=notes.filter(n=>!n.category||!cats.find(c=>c._id===n.category)).length;}
  const _nq=g('nav-quote');   if(_nq){_nq.classList.toggle('on',nav==='quote');const qc=g('cnt-quote');if(qc)qc.textContent=quotes.length;}
  const _nd=g('nav-dash');    if(_nd)_nd.classList.toggle('on',view==='dash'&&nav==='all');

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
  if (nav === 'quote' || view === 'quote') {
    g('page-stats').innerHTML =
      `<span>전체 <strong>${quotes.length}</strong>개</span>`;
    return;
  }
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


// ══════════════════════════════════════════════════════
// 필터 칩 바 렌더
// ══════════════════════════════════════════════════════
function renderChipBar() {
  const isT = nav === 'trash';
  const chipBar = g('chip-bar');
  if (!chipBar) return;

  // 휴지통/명언이면 칩바 숨김
  chipBar.style.display = (isT || nav === 'quote') ? 'none' : '';

  // ── 카테고리 칩
  const scroll = g('chip-scroll');
  if (scroll) {
    const dotColors = ['#3d7fff','#00c896','#ffd060','#a855f7','#06b6d4','#ec4899','#10b981','#f59e0b'];
    const bgColors  = [
      'rgba(61,127,255,.1)','rgba(0,200,150,.1)','rgba(255,208,96,.1)',
      'rgba(168,85,247,.1)','rgba(6,182,212,.1)','rgba(236,72,153,.1)',
      'rgba(16,185,129,.1)','rgba(245,158,11,.1)'
    ];
    scroll.innerHTML = `<button class="chip-cat${nav==='all'?' on':''}" data-nav="all">
        <span class="cc-dot" style="background:var(--acc)"></span>
        전체 <span class="cc-cnt">${notes.length}</span>
      </button>` +
      cats.map((c,i) => {
        const ci = i % 8;
        const cnt = notes.filter(n=>n.category===c._id).length;
        const on  = nav === `cat:${c._id}`;
        return `<button class="chip-cat${on?' on':''}" data-nav="cat:${esc(c._id)}"
          style="${on?'':''}">
          <span class="cc-dot" style="background:${dotColors[ci]}"></span>
          ${esc(c.name)} <span class="cc-cnt">${cnt}</span>
        </button>`;
      }).join('');

    // 카테고리 칩 클릭
    scroll.querySelectorAll('.chip-cat').forEach(btn => {
      btn.addEventListener('click', () => {
        goNav(btn.dataset.nav);
      });
    });
  }

  // ── 태그 칩 (현재 목록에서 많이 쓰인 상위 10개)
  const tagWrap = g('tag-chip-wrap');
  if (tagWrap) {
    const tagCount = {};
    notes.forEach(n => (n.tags||[]).forEach(t => { tagCount[t]=(tagCount[t]||0)+1; }));
    const topTags = Object.entries(tagCount).sort((a,b)=>b[1]-a[1]).slice(0,10);
    tagWrap.innerHTML = topTags.map(([t,cnt]) =>
      `<button class="tchip${filterTag===t?' on':''}" data-tag="${esc(t)}">#${esc(t)}<span style="font-size:9px;margin-left:2px;opacity:.6">${cnt}</span></button>`
    ).join('');
    tagWrap.querySelectorAll('.tchip').forEach(btn => {
      btn.addEventListener('click', () => {
        filterTag = filterTag === btn.dataset.tag ? '' : btn.dataset.tag;
        updateFilterUI();
        renderNotes(); renderStats();
      });
    });
  }

  // ── 필터 버튼 상태 동기화
  updateFilterUI();
}

function updateFilterUI() {
  const fcLink  = g('fc-link');
  const fcWeek  = g('fc-week');
  const fcMonth = g('fc-month');
  const clearBtn = g('chip-clear');
  if (fcLink)  fcLink.classList.toggle('on', filterLink);
  if (fcWeek)  fcWeek.classList.toggle('on', filterPeriod==='week');
  if (fcMonth) fcMonth.classList.toggle('on', filterPeriod==='month');
  const anyFilter = filterLink || filterPeriod || filterTag;
  if (clearBtn) clearBtn.classList.toggle('hidden', !anyFilter);
  // 태그 칩 on 상태 동기화
  document.querySelectorAll('.tchip').forEach(b => b.classList.toggle('on', b.dataset.tag === filterTag));
}

function clearFilters() {
  filterLink = false; filterPeriod = ''; filterTag = '';
  updateFilterUI();
  renderNotes(); renderStats();
}

// ══════════════════════════════════════════════════════
// 대시보드 렌더
// ══════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════
// 사이드바 오늘의 추천요리
// ══════════════════════════════════════════════════════
function getRecipeCat() {
  return cats.find(c => (c.name || '').replace(/\s/g,'').toLowerCase().includes('레시피')) || null;
}

function renderSidebarRecipe(forceNew) {
  const wrap  = document.getElementById('sb-recipe');
  const card  = document.getElementById('sb-recipe-card');
  if (!wrap || !card) return;

  const rCat  = getRecipeCat();
  if (!rCat) { wrap.classList.add('hidden'); return; }

  const pool  = notes.filter(n => !n._deleted && n.category === rCat._id);
  if (!pool.length) { wrap.classList.add('hidden'); return; }

  let n;
  if (forceNew) {
    const curId  = card.dataset.curId || '';
    const others = pool.filter(p => p._id !== curId);
    n = (others.length ? others : pool)[Math.floor(Math.random() * (others.length || pool.length))];
  } else {
    const seed = new Date().toDateString();
    let hash = 0;
    for (const c of seed) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
    n = pool[Math.abs(hash) % pool.length];
  }

  card.dataset.curId = n._id;

  const body    = n.content ? (isRich(n.content) ? stripHtml(n.content) : n.content).slice(0, 120) : '';
  const tagsHtml = (n.tags||[]).length
    ? `<div class="sb-nc-tags">${n.tags.slice(0,5).map(t=>`<span class="sb-nc-tag">#${esc(t)}</span>`).join('')}</div>` : '';
  const hasLink = (n.links||[]).some(l => l?.url);

  card.innerHTML = `
    <div class="sb-nc ${barCls(n.category)}" data-note-id="${n._id}">
      <div class="sb-nc-title">${esc(n.title || '제목 없음')}</div>
      ${body ? `<div class="sb-nc-body">${esc(body)}</div>` : ''}
      ${hasLink ? `<div class="sb-lprev-slot"></div>` : ''}
      ${tagsHtml}
      <div class="sb-nc-foot">📅 ${fmt(n.createdAt)}</div>
    </div>`;

  card.querySelector('.sb-nc').addEventListener('click', e => {
    if (e.target.closest('a')) return; // 링크 클릭은 메모 열기 막기
    openNote(n._id);
  });

  // 링크 썸네일 비동기 로드
  if (hasLink) {
    const link = n.links.find(l => l?.url);
    const slot = card.querySelector('.sb-lprev-slot');
    fetchThumb(link.url).then(data => {
      if (!slot || !data) return;
      const fav = favicon(link.url);
      slot.innerHTML = `<a class="sb-lprev" href="${esc(link.url)}" target="_blank" rel="noopener">
        ${data.img
          ? `<img class="sb-lprev-img" src="${esc(data.img)}" alt="" onerror="this.style.display='none'">`
          : `<div class="sb-lprev-ph">🔗</div>`}
        <div class="sb-lprev-info">
          <div class="sb-lprev-title">${esc(data.title || link.label || domain(link.url))}</div>
          <div class="sb-lprev-url">
            ${fav ? `<img class="sb-lprev-fav" src="${esc(fav)}" alt="" onerror="this.style.display='none'">` : ''}
            <span>${esc(domain(link.url))}</span>
          </div>
        </div>
      </a>`;
    }).catch(()=>{});
  }

  wrap.classList.remove('hidden');
}

function showRandomQuoteBanner() {
  const banner = document.getElementById('quote-banner');
  if (!banner) return;
  if (!quotes || quotes.length === 0) { banner.classList.add('hidden'); return; }

  const q = quotes[Math.floor(Math.random() * quotes.length)];
  document.getElementById('qbanner-text').textContent   = q.text   || '';
  const authorEl = document.getElementById('qbanner-author');
  if (q.author) { authorEl.textContent = q.author; authorEl.style.display = ''; }
  else          { authorEl.textContent = '';        authorEl.style.display = 'none'; }

  banner.classList.remove('hidden');

  // 닫기 버튼
  const closeBtn = document.getElementById('qbanner-close');
  if (closeBtn) {
    closeBtn.onclick = () => {
      banner.style.animation = 'none';
      banner.style.opacity   = '0';
      banner.style.transform = 'translateY(-6px)';
      banner.style.transition = 'opacity .25s,transform .25s';
      setTimeout(() => banner.classList.add('hidden'), 250);
    };
  }
}


let qEditId = null; // 편집 중인 명언 id

function openQuote(id) {
  qEditId = id || null;
  const n = id ? quotes.find(q => q._id === id) : null;

  // 기존 모달 제거 후 새로 생성
  const existing = document.getElementById('quote-ov');
  if (existing) existing.remove();

  const ov = document.createElement('div');
  ov.id = 'quote-ov';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.72);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;';
  ov.innerHTML = `
    <div style="background:var(--card2);border:1px solid var(--bd2);border-radius:18px;width:100%;max-width:500px;box-shadow:0 24px 64px rgba(0,0,0,.72);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--bd);">
        <span style="font-size:15px;font-weight:700;color:var(--t);">${id ? '명언 수정' : '✏️ 새 명언 추가'}</span>
        <button id="qm-close" style="background:none;border:none;color:var(--t3);font-size:20px;cursor:pointer;padding:2px 8px;border-radius:6px;line-height:1;">✕</button>
      </div>
      <div style="padding:20px;display:flex;flex-direction:column;gap:16px;">
        <div style="display:flex;flex-direction:column;gap:6px;">
          <label style="font-size:11px;font-weight:600;color:var(--t3);letter-spacing:.3px;">명언 한 줄 <span style="color:#ec4899">*</span></label>
          <input id="qm-text" type="text" placeholder="명언을 입력하세요..."
            style="padding:10px 14px;background:var(--bg3);border:1px solid var(--bd);border-radius:10px;color:var(--t);font-size:14px;outline:none;width:100%;box-sizing:border-box;"
            maxlength="300" autocomplete="off" value="${esc(n ? (n.text||'') : '')}">
          <div id="qm-cnt" style="font-size:10px;color:var(--t3);text-align:right;">${(n ? (n.text||'') : '').length} / 300</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <label style="font-size:11px;font-weight:600;color:var(--t3);letter-spacing:.3px;">출처 / 작가 <span style="font-weight:400;">(선택)</span></label>
          <input id="qm-author" type="text" placeholder="예: 공자, 스티브 잡스, 익명..."
            style="padding:10px 14px;background:var(--bg3);border:1px solid var(--bd);border-radius:10px;color:var(--t);font-size:14px;outline:none;width:100%;box-sizing:border-box;"
            maxlength="100" autocomplete="off" value="${esc(n ? (n.author||'') : '')}">
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--bd);">
        <button id="qm-cancel" class="btn btng">취소</button>
        <button id="qm-save"   class="btn btnp">저장</button>
      </div>
    </div>`;

  document.body.appendChild(ov);

  // 이벤트
  const txtInp = document.getElementById('qm-text');
  const cntEl  = document.getElementById('qm-cnt');
  txtInp.addEventListener('input', () => {
    const len = txtInp.value.length;
    cntEl.textContent = len + ' / 300';
    cntEl.style.color = len > 270 ? '#ec4899' : 'var(--t3)';
  });
  txtInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSaveQuote(); } });
  document.getElementById('qm-close').addEventListener('click',  closeQuote);
  document.getElementById('qm-cancel').addEventListener('click', closeQuote);
  document.getElementById('qm-save').addEventListener('click',   doSaveQuote);
  ov.addEventListener('click', e => { if (e.target === ov) closeQuote(); });

  setTimeout(() => txtInp.focus(), 80);
}

function closeQuote() {
  const ov = document.getElementById('quote-ov');
  if (ov) ov.remove();
  qEditId = null;
}

function updateQCharCnt() {
  // 동적 생성 방식이므로 별도 호출 불필요 — 하위 호환용 유지
}

async function doSaveQuote() {
  const txtEl    = document.getElementById('qm-text');
  const authorEl = document.getElementById('qm-author');
  if (!txtEl) return;
  const text   = (txtEl.value   || '').trim();
  const author = (authorEl ? authorEl.value : '').trim();
  if (!text) { txtEl.style.borderColor = '#ec4899'; txtEl.focus(); toast('명언을 입력해주세요.', 'wrn'); return; }
  const saveBtn = document.getElementById('qm-save');
  if (saveBtn) saveBtn.disabled = true;
  try {
    const now  = serverTimestamp();
    const data = { text, author };
    if (qEditId) {
      await updateDoc(doc(db, 'users', me.uid, 'quotes', qEditId), { ...data, updatedAt: now });
      const idx = quotes.findIndex(q => q._id === qEditId);
      if (idx >= 0) quotes[idx] = { ...quotes[idx], text, author, updatedAt: new Date().toISOString() };
      toast('명언을 수정했습니다.');
    } else {
      const ref = await addDoc(colQuotes(), { ...data, createdAt: now, updatedAt: now });
      quotes.unshift({ _id: ref.id, text, author, createdAt: new Date().toISOString() });
      toast('명언을 저장했습니다.');
    }
    closeQuote();
    renderAll();
  } catch(e) {
    toast('저장 실패: ' + e.message, 'err');
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function saveQuote() { await doSaveQuote(); } // 하위 호환

async function deleteQuote(id) {
  if (!confirm('이 명언을 삭제할까요?')) return;
  try {
    await deleteDoc(doc(db, 'users', me.uid, 'quotes', id));
    quotes = quotes.filter(q => q._id !== id);
    toast('명언을 삭제했습니다.');
    renderAll();
  } catch(e) {
    toast('삭제 실패: ' + e.message, 'err');
  }
}

function renderQuoteView(wrap) {
  // 페이지네이션 처리
  const fullList = [...quotes].sort((a,b) => new Date(b.createdAt||0) - new Date(a.createdAt||0));
  const pg = g('pagination');
  let list = fullList;
  if (perPage > 0 && scrollMode === 'page') {
    const total   = fullList.length;
    const maxPage = Math.max(1, Math.ceil(total / perPage));
    curPage = Math.min(curPage, maxPage);
    const start   = (curPage - 1) * perPage;
    list = fullList.slice(start, start + perPage);
    if (pg) {
      pg.classList.remove('hidden');
      const info = g('pg-info');
      if (info) info.textContent = curPage + ' / ' + maxPage + ' 페이지';
      const prev = g('pg-prev'), next = g('pg-next');
      if (prev) prev.disabled = curPage <= 1;
      if (next) next.disabled = curPage >= maxPage;
    }
  } else {
    if (pg) pg.classList.add('hidden');
    curPage = 1;
  }

  const startIdx = (perPage > 0 && scrollMode === 'page') ? (curPage-1)*perPage : 0;

  // 상단 추가 버튼 + 목록
  const emptyBody = list.length === 0 ? `
    <div class="q-empty">
      <div class="q-empty-icon">💬</div>
      <p class="q-empty-txt">아직 명언이 없습니다.<br>인상 깊은 한 줄을 기록해보세요!</p>
    </div>` : list.map((q, idx) => `
    <div class="qrow" data-qid="${esc(q._id)}">
      <span class="qrow-num">${startIdx + idx + 1}</span>
      <div class="qrow-body">
        <div class="qrow-quote">${esc(q.text)}</div>
        <div class="qrow-meta">
          ${q.author ? `<span class="qrow-author">${esc(q.author)}</span>` : ''}
          <span class="qrow-date">${fmtShort(q.createdAt)}</span>
        </div>
      </div>
      <span class="qrow-acts">
        <button class="qrow-btn" data-qbtn="edit" title="수정">✏️</button>
        <button class="qrow-btn" data-qbtn="del"  title="삭제">🗑</button>
      </span>
    </div>`).join('');

  wrap.innerHTML = `
    <div class="q-header">
      <span class="q-count">총 ${fullList.length}개의 명언</span>
      <button class="q-add-btn" id="q-add-btn">✏️ 명언 추가</button>
    </div>
    <div class="q-list">${emptyBody}</div>`;

  wrap.querySelector('#q-add-btn').addEventListener('click', () => openQuote());

  wrap.querySelectorAll('.qrow').forEach(el => {
    el.addEventListener('click', e => {
      const btn = e.target.closest('[data-qbtn]');
      if (!btn) return;
      const id = el.dataset.qid;
      if (btn.dataset.qbtn === 'edit') openQuote(id);
      if (btn.dataset.qbtn === 'del')  deleteQuote(id);
    });
  });
}

function renderDash(wrap) {
  wrap.className = 'vdash';
  const DOT = ['#3d7fff','#00c896','#ffd060','#a855f7','#06b6d4','#ec4899','#10b981','#f59e0b'];
  const now  = new Date();

  // ── 상대시간
  function relTime(d) {
    if (!d) return '';
    const diff = Math.floor((now - new Date(d)) / 1000);
    if (diff < 60)      return '방금 전';
    if (diff < 3600)    return Math.floor(diff/60)+'분 전';
    if (diff < 86400)   return Math.floor(diff/3600)+'시간 전';
    if (diff < 86400*2) return '어제';
    if (diff < 86400*7) return Math.floor(diff/86400)+'일 전';
    return fmtShort(d);
  }

  // ── 미니 카드
  function miniCard(n) {
    const ci  = catColorIdx(n.category);
    const col = ci >= 0 ? DOT[ci] : 'var(--t3)';
    const cat = catLabel(n.category);
    const body = n.content ? (isRich(n.content) ? stripHtml(n.content) : n.content).slice(0,90) : '';
    return `<div class="dmini" data-note-id="${n._id}">
      <div class="dmini-bar" style="background:${col}"></div>
      <div class="dmini-body">
        <div class="dmini-top">
          <span class="dmini-title">${esc((n.title||'제목없음').slice(0,22))}</span>
          ${n.starred ? '<span class="dmini-star">★</span>' : ''}
        </div>
        ${body ? `<div class="dmini-text">${esc(body)}</div>` : ''}
        <div class="dmini-foot">
          ${cat!=='카테고리없음'?`<span class="dmini-badge" style="color:${col}">${esc(cat)}</span>`:''}
          <span class="dmini-date">${relTime(n.updatedAt||n.createdAt)}</span>
        </div>
      </div>
    </div>`;
  }

  // ── 최근글 (12개)
  const recentNotes = [...notes]
    .sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0))
    .slice(0, 12);

  // ── 즐겨찾기 (12개)
  const starredNotes = notes.filter(n=>n.starred)
    .sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0))
    .slice(0, 12);

  // ── 카테고리별 최근글 (카테고리당 최대 3개)
  const catGroups = cats.map((c, idx) => {
    const ci  = idx % 8;
    const col = DOT[ci];
    const items = notes.filter(n=>n.category===c._id)
      .sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0))
      .slice(0, 3);
    return { c, ci, col, items, total: notes.filter(n=>n.category===c._id).length };
  }).filter(g => g.items.length > 0);

  // ── 태그 TOP 8
  const tagMap = {};
  notes.forEach(n=>(n.tags||[]).forEach(t=>{tagMap[t]=(tagMap[t]||0)+1;}));
  const topTags = Object.entries(tagMap).sort((a,b)=>b[1]-a[1]).slice(0,8);
  const maxTC = topTags[0]?.[1] || 1;
  const totalTagCount = Object.keys(tagMap).length;

  wrap.innerHTML = `<div class="dash-grid">

    <!-- ① 최근글 + 즐겨찾기 2열 -->
    <div class="db2-top">

      <!-- 최근글 -->
      <div class="dash-section">
        <div class="dash-sec-hd">
          <span class="dash-sec-title">🕐 최근 수정</span>
          <button class="dash-sec-more" data-nav="all">전체 보기 →</button>
        </div>
        <div class="dmini-grid">${recentNotes.map(n=>miniCard(n)).join('')}</div>
      </div>

      <!-- 즐겨찾기 -->
      <div class="dash-section${starredNotes.length===0?' ds-empty':''}">
        <div class="dash-sec-hd">
          <span class="dash-sec-title">⭐ 즐겨찾기</span>
          ${starredNotes.length>0?`<button class="dash-sec-more" data-nav="starred">전체 보기 →</button>`:''}
        </div>
        ${starredNotes.length===0
          ? `<div class="dash-empty-hint">즐겨찾기한 메모가 없습니다</div>`
          : `<div class="dmini-grid">${starredNotes.map(n=>miniCard(n)).join('')}</div>`
        }
      </div>
    </div>

    <!-- ② 카테고리별 최근글 -->
    <div class="dash-section">
      <div class="dash-sec-hd">
        <span class="dash-sec-title">📂 카테고리별 최근글</span>
        <span class="dash-sec-sub">${cats.length}개 카테고리</span>
      </div>
      <div class="dcat-groups">
        ${catGroups.map(({c,col,items,total})=>`
          <div class="dcat-group">
            <div class="dcat-group-hd" data-nav="cat:${esc(c._id)}">
              <span class="dcat-group-dot" style="background:${col}"></span>
              <span class="dcat-group-name">${esc(c.name)}</span>
              <span class="dcat-group-cnt" style="color:${col}">${total}개</span>
            </div>
            <div class="dcat-group-list">
              ${items.map(n=>`
                <div class="dcat-item" data-note-id="${n._id}">
                  <span class="dcat-item-title">${esc((n.title||'제목없음').slice(0,30))}</span>
                  <span class="dcat-item-date">${relTime(n.updatedAt||n.createdAt)}</span>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>
    </div>

    <!-- ③ 인기 태그 -->
    <div class="dash-section">
      <div class="dash-sec-hd">
        <span class="dash-sec-title">🏷 인기 태그</span>
        <span class="dash-sec-sub">전체 ${totalTagCount}개</span>
      </div>
      <div class="dtag-chips">
        ${topTags.length===0?'<span style="color:var(--t3);font-size:12px">태그 없음</span>':''}
        ${topTags.map(([tag,cnt],rank)=>{
          const col=DOT[rank%8];
          const bar=Math.round(cnt/maxTC*100);
          return `<div class="dtag-chip" data-tag="${esc(tag)}" style="--chip-col:${col}">
            <span class="dtag-chip-name">#${esc(tag)}</span>
            <span class="dtag-chip-cnt">${cnt}</span>
            <div class="dtag-chip-bar" style="width:${bar}%"></div>
          </div>`;
        }).join('')}
      </div>
    </div>

  </div>`;

  // ── 이벤트
  wrap.querySelectorAll('.dmini[data-note-id]').forEach(el=>{
    el.addEventListener('click',()=>openDet(el.dataset.noteId));
  });
  wrap.querySelectorAll('.dash-sec-more[data-nav]').forEach(el=>{
    el.addEventListener('click', e=>{e.stopPropagation(); goNav(el.dataset.nav);});
  });
  wrap.querySelectorAll('.dcat-group-hd[data-nav]').forEach(el=>{
    el.addEventListener('click',()=>goNav(el.dataset.nav));
  });
  wrap.querySelectorAll('.dcat-item[data-note-id]').forEach(el=>{
    el.addEventListener('click',()=>openDet(el.dataset.noteId));
  });
  wrap.querySelectorAll('.dtag-chip[data-tag]').forEach(el=>{
    el.addEventListener('click',()=>{
      filterTag=el.dataset.tag;
      goNav('all');setView('grid');updateFilterUI();renderNotes();renderStats();
    });
  });
}



function renderNotes() {
  const wrap = g('notes-wrap');
  const isT  = nav === 'trash';
  const q    = (g('search-inp')?.value || '').trim();

  // 대시보드 뷰
  if (view === 'dash') {
    wrap.className = 'vdash';
    renderDash(wrap);
    return;
  }

  // 한줄명언 뷰
  if (nav === 'quote' || view === 'quote') {
    wrap.className = 'vquote';
    renderQuoteView(wrap);
    return;
  }

  wrap.className = `v${view}`;
  const fullList = getFiltered();

  // ── 페이지네이션 / 스크롤 처리
  let list = fullList;
  const pg = g('pagination');
  if (perPage > 0 && scrollMode === 'page' && view !== 'kanban' && view !== 'timeline') {
    const total   = fullList.length;
    const maxPage = Math.max(1, Math.ceil(total / perPage));
    curPage = Math.min(curPage, maxPage);
    const start = (curPage - 1) * perPage;
    list = fullList.slice(start, start + perPage);
    if (pg) {
      pg.classList.remove('hidden');
      const info = g('pg-info');
      if (info) info.textContent = `${curPage} / ${maxPage} 페이지`;
      const prev = g('pg-prev'), next = g('pg-next');
      if (prev) prev.disabled = curPage <= 1;
      if (next) next.disabled = curPage >= maxPage;
    }
  } else {
    if (pg) pg.classList.add('hidden');
    curPage = 1;
  }

  if (!list.length) {
    wrap.innerHTML = `<div class="empty">
      <div class="empty-icon">${isT ? '🗑️' : q ? '🔍' : '📭'}</div>
      <p>${isT ? '휴지통이 비어있습니다.' : q ? `"${esc(q)}" 검색 결과 없음` : '메모가 없습니다. 새 메모를 작성해보세요!'}</p>
    </div>`;
    return;
  }

  // 뷰별 렌더링
  if (view === 'kanban') {
    renderKanban(wrap, list, isT);
    return;
  }
  if (view === 'timeline') {
    wrap.innerHTML = timelineHtml(list, isT);
  } else {
    const htmlFn = view === 'grid' ? cardHtml
                 : view === 'list' ? listHtml
                 : view === 'magazine' ? magHtml
                 : view === 'compact' ? compactHtml
                 : cardHtml;
    wrap.innerHTML = list.map(n => htmlFn(n, isT)).join('');
  }

  // 링크 썸네일 비동기 로드 (카드/매거진/타임라인)
  if (['grid', 'magazine', 'timeline'].includes(view)) {
    setTimeout(() => loadThumbnails(list), 100);
  }

  // 메모 클릭 이벤트 위임
  wrap.querySelectorAll('[data-note-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      const id  = el.dataset.noteId;
      const isT = el.dataset.istrash === '1';
      // 액션 버튼 (data-btn 속성으로 구분)
      const btn = e.target.closest('[data-btn]');
      if (btn) {
        const act = btn.dataset.btn;
        if (act === 'star')    { toggleStar(id); return; }
        if (act === 'edit')    { openEdit(id);  return; }
        if (act === 'trash')   { doTrash(id);   return; }
        if (act === 'restore') { doRestore(id); return; }
        if (act === 'hardel')  { doHardDel(id); return; }
      }
      // 상세보기 (링크칩/썸네일 클릭 제외)
      if (!e.target.closest('a')) openDet(id, isT);
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
    <button class="na grn" data-btn="restore">복원</button>
    <button class="na del" data-btn="hardel">완전삭제</button>`;
  const n = notes.find(x=>x._id===id);
  const sc = n?.starred ? 'na star on' : 'na star';
  const si = n?.starred ? '★' : '☆';
  return `
    <button class="${sc}" data-btn="star" title="즐겨찾기">${si}</button>
    <button class="na"   data-btn="edit">수정</button>
    <button class="na del" data-btn="trash">삭제</button>`;
}

// ─────────────────────────────────────────
// COMPACT VIEW
// ─────────────────────────────────────────
function compactHtml(n, isT) {
  return `<div class="nco ${barCls(n.category)}" data-note-id="${n._id}" data-istrash="${isT?'1':'0'}">
    <span class="nco-dot ${dotCls(n.category)}"></span>
    <span class="nco-title">${esc(n.title || '제목 없음')}</span>
    ${(n.tags||[]).length ? `<span class="nco-badge bdX" style="font-size:9px">#${esc(n.tags[0])}</span>` : ''}
    <span class="nco-badge ${badgeCls(n.category)}">${esc(catLabel(n.category))}</span>
    <span class="nco-date">${fmtShort(n.createdAt)}</span>
    <div class="nco-acts">${actBtns(n._id, isT)}</div>
  </div>`;
}

// ─────────────────────────────────────────
// TIMELINE VIEW
// ─────────────────────────────────────────
function timelineHtml(list, isT) {
  if (!list.length) return '';
  const groups = new Map();
  list.forEach(n => {
    const d = n.createdAt ? new Date(n.createdAt) : new Date();
    let key, label;
    if (tlGroup === 'year') {
      key = String(d.getFullYear());
      label = `📆 ${d.getFullYear()}년`;
    } else if (tlGroup === 'month') {
      key = `${d.getFullYear()}.${String(d.getMonth()+1).padStart(2,'0')}`;
      label = `📅 ${d.getFullYear()}년 ${d.getMonth()+1}월`;
    } else {
      key = fmtShort(d);
      label = (fmtShort(new Date())===key) ? `📅 오늘 · ${key}` : `📅 ${key}`;
    }
    if (!groups.has(key)) groups.set(key, {label, items:[]});
    groups.get(key).items.push(n);
  });
  let html = '';
  groups.forEach(({label, items}) => {
    html += `<div class="tl-group">
      <div class="tl-date-hd">
        <div class="tl-date-line"></div>
        <span class="tl-date-lbl">${label}</span>
        <span style="font-size:10px;color:var(--t3);flex-shrink:0">${items.length}개</span>
        <div class="tl-date-line"></div>
      </div>
      <div class="tl-items">
        ${items.map(n => `<div class="tl-dot-wrap">${cardHtml(n, isT)}</div>`).join('')}
      </div>
    </div>`;
  });
  return html;
}

function renderKanban(wrap, list, isT) {
  wrap.className = '';
  wrap.style.cssText = '';

  // 카테고리별 그룹 + 미분류
  const cols = [];
  cats.forEach((c, i) => {
    const items = list.filter(n => n.category === c._id);
    cols.push({ id: c._id, name: c.name, ci: i % 8, items });
  });
  const uncat = list.filter(n => !n.category || !cats.find(c => c._id === n.category));
  if (uncat.length) cols.push({ id: '', name: '카테고리없음', ci: -1, items: uncat });

  const barColors = [
    'linear-gradient(90deg,#3d7fff,#5b9bff)','linear-gradient(90deg,#00c896,#00e6a8)',
    'linear-gradient(90deg,#ffd060,#ff9500)','linear-gradient(90deg,#a855f7,#c084fc)',
    'linear-gradient(90deg,#06b6d4,#22d3ee)','linear-gradient(90deg,#ec4899,#f97316)',
    'linear-gradient(90deg,#10b981,#34d399)','linear-gradient(90deg,#f59e0b,#fbbf24)'
  ];
  const dotColors = ['#3d7fff','#00c896','#ffd060','#a855f7','#06b6d4','#ec4899','#10b981','#f59e0b'];

  wrap.innerHTML = `<div class="vkanban-wrap">${
    cols.map(col => `
      <div class="kb-col">
        <div class="kb-col-bar" style="background:${col.ci>=0?barColors[col.ci]:barColors[0]}"></div>
        <div class="kb-col-hd">
          <span class="kb-col-dot" style="background:${col.ci>=0?dotColors[col.ci]:'var(--t3)'}"></span>
          <span class="kb-col-name">${esc(col.name)}</span>
          <span class="kb-col-cnt">${col.items.length}</span>
        </div>
        <div class="kb-items">
          ${col.items.length ? col.items.map(n => kanbanCardHtml(n, isT)).join('') : `<div style="font-size:11px;color:var(--t3);padding:8px 4px">메모 없음</div>`}
        </div>
      </div>`
    ).join('')
  }</div>`;

  // 이벤트 바인딩
  wrap.querySelectorAll('[data-note-id]').forEach(el => {
    el.addEventListener('click', e => {
      const id  = el.dataset.noteId;
      const isT = el.dataset.istrash === '1';
      const btn = e.target.closest('[data-btn]');
      if (btn) {
        const act = btn.dataset.btn;
        if (act === 'edit')    { openEdit(id);  return; }
        if (act === 'trash')   { doTrash(id);   return; }
        if (act === 'restore') { doRestore(id); return; }
        if (act === 'hardel')  { doHardDel(id); return; }
      }
      if (e.target.closest('a')) return;
      openDet(id, isT);
    });
  });
}

function kanbanCardHtml(n, isT) {
  const prev = (n.content||'').replace(/\n/g,' ').slice(0,70);
  return `<div class="kb-card" data-note-id="${n._id}" data-istrash="${isT?'1':'0'}">
    <div class="kb-title">${esc(n.title||'제목 없음')}</div>
    ${prev ? `<div class="kb-prev">${esc(prev)}</div>` : ''}
    <div class="kb-foot">
      <span style="color:var(--t3)">${fmtShort(n.createdAt)}</span>
      <div class="kb-acts">${actBtns(n._id, isT)}</div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────
// LINK THUMBNAIL (microlink.io)
// ─────────────────────────────────────────
// URL → 충돌 없는 캐시 키 (전체 URL 해시)
function thumbCacheKey(url) {
  // 간단한 djb2 해시 → 16진수 문자열 (URL 전체 반영)
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h) ^ url.charCodeAt(i);
  return 'thumb2_' + (h >>> 0).toString(16) + '_' + url.length;
}

async function fetchThumb(url) {
  if (thumbCache.has(url)) return thumbCache.get(url);
  // localStorage 캐시 확인 (thumb2_ 키 사용 — 구버전 thumb_ 키는 무시)
  try {
    const key = thumbCacheKey(url);
    const cached = localStorage.getItem(key);
    if (cached) { const d = JSON.parse(cached); thumbCache.set(url, d); return d; }
  } catch(_) {}
  try {
    const r = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}&palette=false&audio=false&video=false&iframe=false`);
    const j = await r.json();
    const d = j.status === 'success' ? {
      img:   j.data?.image?.url || j.data?.logo?.url || '',
      title: j.data?.title || '',
      desc:  j.data?.description || '',
      url:   j.data?.url || url
    } : null;
    thumbCache.set(url, d);
    if (d) try { localStorage.setItem(thumbCacheKey(url), JSON.stringify(d)); } catch(_) {}
    return d;
  } catch(_) { thumbCache.set(url, null); return null; }
}

async function thumbCardHtml(l, data) {
  const fav = favicon(l.url);
  return `<a class="lprev det-thumb" href="${esc(l.url)}" target="_blank" rel="noopener" style="max-width:100%">
    ${data.img
      ? `<img class="lprev-img" src="${esc(data.img)}" alt="" style="height:160px" onerror="this.style.display='none'">`
      : `<div class="lprev-img-ph">🔗</div>`}
    <div class="lprev-info">
      <div class="lprev-title">${esc(data.title || l.label || domain(l.url))}</div>
      ${data.desc ? `<div class="lprev-desc">${esc(data.desc)}</div>` : ''}
      <div class="lprev-url">
        ${fav ? `<img class="lprev-fav" src="${esc(fav)}" alt="" onerror="this.style.display='none'">` : ''}
        <span>${esc(domain(l.url))}</span>
      </div>
    </div>
  </a>`;
}

async function loadThumbnails(list) {
  for (const n of list) {
    const link = (n.links||[]).find(l => l?.url);
    if (!link) continue;
    const el = document.querySelector(`[data-note-id="${n._id}"] .lprev-slot`);
    if (!el) continue;
    const data = await fetchThumb(link.url);
    if (!data) continue;
    const fav = favicon(link.url);
    el.innerHTML = `<a class="lprev" href="${esc(link.url)}" target="_blank" rel="noopener">
      ${data.img ? `<img class="lprev-img" src="${esc(data.img)}" alt="" onerror="this.parentElement.querySelector('.lprev-img-ph') && (this.style.display='none')">` : `<div class="lprev-img-ph">🔗</div>`}
      <div class="lprev-info">
        <div class="lprev-title">${esc(data.title || link.label || domain(link.url))}</div>
        ${data.desc ? `<div class="lprev-desc">${esc(data.desc)}</div>` : ''}
        <div class="lprev-url">
          ${fav ? `<img class="lprev-fav" src="${esc(fav)}" alt="" onerror="this.style.display='none'">` : ''}
          <span>${esc(domain(link.url))}</span>
        </div>
      </div>
    </a>`;
  }
}

function fmtShort(d) {
  if (!d) return '-';
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt)) return '-';
  const p = n => String(n).padStart(2,'0');
  const days=['일','월','화','수','목','금','토'];
  return `${dt.getFullYear()}.${p(dt.getMonth()+1)}.${p(dt.getDate())}(${days[dt.getDay()]})`;
}

function cardHtml(n, isT) {
  const hasLink = (n.links||[]).some(l => l?.url);
  return `<div class="nc ${barCls(n.category)}" data-note-id="${n._id}" data-istrash="${isT?'1':'0'}">
    <div class="nhead">
      <div class="ntitle">${esc(n.title || '제목 없음')}</div>
      <span class="nbadge ${badgeCls(n.category)}">${esc(catLabel(n.category))}</span>
    </div>
    ${n.content ? `<div class="nbody">${isRich(n.content) ? esc(stripHtml(n.content)).slice(0,180) : esc(n.content)}</div>` : ''}
    ${hasLink ? `<div class="lprev-slot"></div>` : ''}
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
  const rawContent = isRich(n.content) ? stripHtml(n.content) : (n.content || '');
  const prev = rawContent.replace(/\n/g, ' ').slice(0, 90);
  return `<div class="nl ${barCls(n.category)}" data-note-id="${n._id}" data-istrash="${isT?'1':'0'}">
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
  return `<div class="nm ${barCls(n.category)}" data-note-id="${n._id}" data-istrash="${isT?'1':'0'}">
    <div class="nmhd ${magCls(n.category)}">${emoji}
      <div class="nmbar"${ci>=0?' style="background:linear-gradient(90deg,var(--acc),transparent)"':''}></div>
    </div>
    <div class="nmbody">
      <div class="nhead">
        <div class="ntitle">${esc(n.title || '제목 없음')}</div>
        <span class="nbadge ${badgeCls(n.category)}">${esc(catLabel(n.category))}</span>
      </div>
      ${n.content ? `<div class="nbody">${isRich(n.content) ? esc(stripHtml(n.content)).slice(0,180) : esc(n.content)}</div>` : ''}
      ${(n.links||[]).some(l=>l?.url) ? `<div class="lprev-slot"></div>` : ''}
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
async function doTrash(id) {
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
  // 한줄명언 뷰 전환
  if (target === 'quote') {
    view = 'quote';
    const tb = document.querySelector('.toolbar');
    if (tb) tb.classList.add('quote-mode');
    renderTitle(); renderAll();
    if (window.innerWidth <= 768) closeMobileSb();
    return;
  }
  // 한줄명언에서 다른 nav로 이동 시 view 복원
  if (view === 'quote') {
    view = 'grid';
    const tb = document.querySelector('.toolbar');
    if (tb) tb.classList.remove('quote-mode');
  }
  // 대시보드 뷰에서 이동 시 → grid로 전환
  if (view === 'dash') setView('grid');
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
  ['grid', 'list', 'magazine', 'compact', 'timeline', 'kanban'].forEach(m => {
    const btn = g(`vb-${m}`);
    if (btn) btn.classList.toggle('on', m === mode);
  });
  const _tlw = g('tl-grp-wrap');
  if (_tlw) _tlw.classList.toggle('hidden', mode !== 'timeline');
  renderNotes();
}

// ══════════════════════════════════════════════════════
// Quill 리치텍스트 에디터
// ══════════════════════════════════════════════════════
function initQuill() {
  if (quillInst) return;
  if (!window.Quill) return;
  const toolbarOptions = [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['blockquote', 'code-block'],
    ['link'],
    ['clean']
  ];
  quillInst = new Quill('#e-content-quill', {
    theme: 'snow',
    placeholder: '내용을 입력하세요...',
    modules: {
      keyboard: {
        bindings: {
          // "1. " 자동 리스트 변환 비활성화
          'list autofill': {
            key: ' ',
            shiftKey: null,
            prefix: /^\s*?(\d+\.|\*|-)\s{0,1}$/,
            handler() { return true; }
          }
        }
      },
      toolbar: {
        container: toolbarOptions,
        handlers: {
          link: function(value) {
            if (value) {
              const range = this.quill.getSelection();
              if (!range || range.length === 0) {
                toast('링크를 붙일 텍스트를 먼저 선택하세요.', 'wrn');
                return;
              }
              const url = prompt('링크 URL을 입력하세요:', 'https://');
              if (url && url.trim() !== 'https://') {
                this.quill.format('link', url.trim());
              }
            } else {
              this.quill.format('link', false);
            }
          }
        }
      }
    }
  });
  // 기본 글자색 강제 설정 (Quill이 black을 기본값으로 주입하는 것 방지)
  quillInst.format('color', false); // 인라인 color 속성 제거
  quillInst.root.style.color = ''; // 인라인 스타일 초기화 → CSS var(--t) 적용

  // Quill 변경 시 hidden input 동기화 + 태그 추출
  // 붙여넣기 시 Quill의 scrollIntoView 가 mbody 를 상단으로 올리는 현상 방지
  quillInst.on('text-change', (delta, oldDelta, source) => {
    const mbody = document.querySelector('.mbody');
    const savedScroll = mbody ? mbody.scrollTop : 0;

    const html  = quillInst.root.innerHTML;
    const plain = quillInst.getText();
    g('e-content').value = html === '<p><br></p>' ? '' : html;
    const newTags = extractTags(plain);
    newTags.forEach(t => { if (!eTags.includes(t)) eTags.push(t); });
    renderTagPre();

    // 붙여넣기(api 아닌 user 입력)일 때 스크롤 복원
    if (source === 'user' && mbody) {
      requestAnimationFrame(() => { mbody.scrollTop = savedScroll; });
    }
  });

  // ── Quill 내부 마우스 스크롤
  // ql-editor(내용 영역)와 ql-container(스크롤 박스) 모두 처리
  const qlRoot      = quillInst.root; // .ql-editor
  const qlContainer = qlRoot.closest('.ql-container');

  // wheel 이벤트: ql-editor 위에서 스크롤하면 ql-container가 스크롤되도록
  if (qlContainer) {
    qlContainer.addEventListener('wheel', (e) => {
      // 스크롤 가능 범위 확인
      const atTop    = qlContainer.scrollTop === 0 && e.deltaY < 0;
      const atBottom = qlContainer.scrollTop + qlContainer.clientHeight >= qlContainer.scrollHeight - 1 && e.deltaY > 0;
      if (!atTop && !atBottom) {
        // 내부에서 소화 가능 → 이벤트 버블링 차단 (mbody 스크롤 방지)
        e.stopPropagation();
      }
      // preventDefault는 하지 않음 → 브라우저 기본 스크롤 동작 유지
    }, { passive: true });
  }

  // ── 툴바 mousedown 시 ql-container 스크롤 위치 보존 + 스크롤 점프 방지
  const toolbar = quillInst.getModule('toolbar');
  if (toolbar && toolbar.container) {
    toolbar.container.addEventListener('mousedown', e => {
      const savedTop = qlContainer ? qlContainer.scrollTop : 0;
      e.preventDefault(); // 포커스 이탈 차단
      requestAnimationFrame(() => {
        if (qlContainer) qlContainer.scrollTop = savedTop;
      });
    });
  }

  // scrollIntoView 비활성화 (서식 적용 시 스크롤 점프 방지)
  quillInst.scrollIntoView = function() {};

  // 붙여넣기 시 mbody 스크롤 위치 완전 고정
  quillInst.root.addEventListener('paste', () => {
    const mbody = document.querySelector('.mbody');
    if (!mbody) return;
    const savedTop = mbody.scrollTop;
    // paste 처리 완료 후 두 프레임에 걸쳐 복원 (Quill 내부 처리 대기)
    requestAnimationFrame(() => {
      mbody.scrollTop = savedTop;
      requestAnimationFrame(() => { mbody.scrollTop = savedTop; });
    });
  }, true); // capture 단계에서 처리
}

function setQuillContent(html) {
  if (!quillInst) initQuill();
  if (!quillInst) return;
  if (!html) {
    quillInst.setContents([]);
    return;
  }
  if (isRich(html)) {
    quillInst.root.innerHTML = html;
  } else {
    // 평문이면 텍스트로 삽입
    quillInst.setText(html);
  }
}

function getQuillContent() {
  if (!quillInst) return g('e-content').value || '';
  const html = quillInst.root.innerHTML;
  return html === '<p><br></p>' ? '' : html;
}

// ══════════════════════════════════════════════════════
// 편집 모달
// ══════════════════════════════════════════════════════
function openAdd() {
  editId = null; eTags = []; eLinks = [];
  g('edit-modal-title').textContent = '새 메모';
  g('e-title').value   = '';
  g('e-content').value = '';
  // 작성일자 기본값: 현재 시각
  const _now = new Date();
  _now.setMinutes(_now.getMinutes() - _now.getTimezoneOffset());
  if (g('e-created-at')) g('e-created-at').value = _now.toISOString().slice(0,16);
  fillCatSelect();
  if (nav.startsWith('cat:')) g('e-cat').value = nav.slice(4);
  else g('e-cat').value = '';
  renderTagPre();
  renderLinkRows();
  g('edit-ov').classList.add('on');
  setTimeout(() => { initQuill(); setQuillContent(''); loadDraftIfExists(); startDraftTimer(); g('e-title').focus(); }, 80);
}

function openEdit(id) {
  const n = notes.find(x => x._id === id);
  if (!n) return;
  editId = id; eLinks = (n.links || []).map(l => ({...l}));
  // 본문 자동추출 태그 제외한 수동 태그만 eTags에 로드
  const _autoTags = extractTags(n.content || '');
  eTags = (n.tags || []).filter(t => !_autoTags.includes(t));
  g('edit-modal-title').textContent = '메모 수정';
  g('e-title').value   = n.title   || '';
  g('e-content').value = n.content || '';
  // 작성일자 로드
  const _cdat = n.createdAt ? new Date(n.createdAt) : new Date();
  _cdat.setMinutes(_cdat.getMinutes() - _cdat.getTimezoneOffset());
  if (g('e-created-at')) g('e-created-at').value = _cdat.toISOString().slice(0,16);
  fillCatSelect();
  g('e-cat').value = n.category || '';
  renderTagPre();
  renderLinkRows();
  g('edit-ov').classList.add('on');
  closeDet();
  setTimeout(() => {
    initQuill();
    setQuillContent(n.content || '');
    startDraftTimer();
  }, 80);
}

async function closeEdit(force = false) {
  if (!force) {
    const hasTitle   = (g('e-title')?.value || '').trim().length > 0;
    const hasContent = getQuillContent().replace(/<[^>]*>/g, '').trim().length > 0;
    if (hasTitle || hasContent) {
      if (!confirm('작성 중인 내용이 있습니다.\n저장하지 않고 닫을까요?')) return;
    }
  }
  g('edit-ov').classList.remove('on');
  stopDraftTimer();
  clearDraft();
}

async function saveNote() {
  const title    = g('e-title').value.trim();
  const content  = getQuillContent();
  const category = g('e-cat').value;
  if (!title) { toast('제목을 입력해주세요.', 'wrn'); g('e-title').focus(); return; }
  const allTags = [...new Set([...eTags, ...extractTags(content)])];
  const data    = { title, content, category, tags: allTags, links: eLinks.filter(l => l?.url) };
  // 작성일자 처리
  const _createdAtVal = g('e-created-at')?.value;
  const _createdAt    = _createdAtVal ? new Date(_createdAtVal) : null;
  try {
    if (editId) {
      if (_createdAt) {
        await setDoc(doc(colNotes(), editId), { createdAt: _createdAt }, { merge: true });
        const ni = notes.findIndex(n => n._id === editId);
        if (ni >= 0) notes[ni].createdAt = _createdAt;
      }
      await updateNote(editId, data);
      toast('수정되었습니다. ✅');
    } else {
      if (_createdAt) data._customCreatedAt = _createdAt;
      await createNote(data);
      toast('저장되었습니다. ✅');
    }
    closeEdit(true);
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
function renderTagInput() {
  const chips = g('tag-chips');
  if (!chips) return;

  // 현재 본문에서 자동추출된 태그
  const autoRaw  = extractTags(getQuillContent ? getQuillContent() : (g('e-content')?.value || ''));
  const autoOnly = autoRaw.filter(t => !eTags.includes(t)); // 수동에 없는 것만 표시

  chips.innerHTML = [
    // 수동 태그 (파란색, 삭제 가능)
    ...eTags.map((t, i) =>
      `<span class="tag-chip" data-ti="${i}">#${esc(t)}<button class="tag-chip-del" data-ti="${i}" type="button">✕</button></span>`
    ),
    // 자동추출 태그 (초록색, 미리보기)
    ...autoOnly.map(t =>
      `<span class="tag-chip auto" title="본문에서 자동추출">#${esc(t)}</span>`
    )
  ].join('');

  chips.querySelectorAll('.tag-chip-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      eTags.splice(parseInt(btn.dataset.ti), 1);
      renderTagInput();
    });
  });

  // hint 업데이트
  const hint = g('tag-hint');
  if (hint) {
    if (autoOnly.length > 0) {
      hint.textContent = `본문에서 ${autoOnly.length}개 태그 자동 감지됨 (저장 시 추가)`;
    } else {
      hint.textContent = '본문의 #태그는 저장 시 자동 추가됩니다';
    }
  }
}

function addTag(raw) {
  // '#' 제거, 공백 제거, 빈값 무시
  const tag = raw.replace(/^#+/, '').replace(/[,\s]+/g, '').trim();
  if (!tag) return;
  if (!eTags.includes(tag)) {
    eTags.push(tag);
    renderTagInput();
  }
}

// 하위호환 alias
function renderTagPre() { renderTagInput(); }

// ══════════════════════════════════════════════════════
// 상세보기 모달
// ══════════════════════════════════════════════════════
function openDet(id, isT) {
  const pool = isT ? trashed : notes;
  const n    = pool.find(x => x._id === id);
  if (!n) return;

  g('det-title').textContent = n.title || '제목 없음';

  const links = (n.links || []).filter(l => l?.url);

  // 링크: 우선 칩(chip) 형태로 빠르게 렌더 후 썸네일 비동기 교체
  const linkSlotsHtml = links.map((l, i) => {
    const fav = favicon(l.url);
    const cached = thumbCache.get(l.url);
    if (cached) {
      return thumbCardHtml(l, cached);
    }
    // 로딩 플레이스홀더
    return `<div class="det-lprev-slot" data-li="${i}" data-url="${esc(l.url)}">
      <a class="detlink" href="${esc(l.url)}" target="_blank" rel="noopener">
        ${fav ? `<img src="${esc(fav)}" alt="" onerror="this.style.display='none'">` : '<span>🔗</span>'}
        <div class="detlinfo">
          <div class="detlname">${esc(l.label || domain(l.url))}</div>
          <div class="detlurl">${esc(domain(l.url))}</div>
        </div>
      </a>
    </div>`;
  }).join('');

  g('det-body').innerHTML = `
    <span class="nbadge ${badgeCls(n.category)}" style="width:fit-content">${esc(catLabel(n.category))}</span>
    ${n.content ? (isRich(n.content) ? `<div class="det-rich">${n.content}</div>` : `<div class="detcontent">${esc(n.content)}</div>`) : ''}
    ${links.length ? `<div class="detlinks" style="flex-direction:column">${linkSlotsHtml}</div>` : ''}
    ${tagsHtml(n.tags)}
    <div class="detmeta">
      <span>📅 작성: ${fmt(n.createdAt)}</span>
      <span>✏️ 수정: ${fmt(n.updatedAt)}</span>
      ${isT && n.deletedAt ? `<span style="color:var(--red)">🗑 삭제: ${fmt(n.deletedAt)}</span>` : ''}
    </div>`;

  // 썸네일 비동기 로드 (캐시 없는 것만)
  links.forEach((l, i) => {
    if (thumbCache.has(l.url)) return;
    fetchThumb(l.url).then(data => {
      const slot = document.querySelector(`.det-lprev-slot[data-li="${i}"]`);
      if (!slot) return;
      slot.outerHTML = data ? thumbCardHtml(l, data) : `<a class="detlink" href="${esc(l.url)}" target="_blank" rel="noopener">
        <span>🔗</span>
        <div class="detlinfo">
          <div class="detlname">${esc(l.label || domain(l.url))}</div>
          <div class="detlurl">${esc(domain(l.url))}</div>
        </div>
      </a>`;
    });
  });

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
  g('new-btn').addEventListener('click', () => {
    if (nav === 'quote' || view === 'quote') openQuote();
    else openAdd();
  });

  // 뷰 전환
  g('vb-grid').addEventListener('click',     () => setView('grid'));
  g('vb-list').addEventListener('click',     () => setView('list'));
  g('vb-magazine').addEventListener('click', () => setView('magazine'));
  g('vb-compact').addEventListener('click',  () => setView('compact'));
  g('vb-timeline').addEventListener('click', () => setView('timeline'));
  g('vb-kanban').addEventListener('click',   () => setView('kanban'));

  // 타임라인 그룹 토글
  ['day','month','year'].forEach(unit => {
    const btn = g(`tl-grp-${unit}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      tlGroup = unit;
      ['day','month','year'].forEach(u => g(`tl-grp-${u}`)?.classList.toggle('on', u === unit));
      if (view === 'timeline') renderNotes();
    });
  });
  // 타임라인 그룹 토글
  ['day','month','year'].forEach(unit => {
    const _b = g('tl-grp-' + unit);
    if (!_b) return;
    _b.addEventListener('click', () => {
      tlGroup = unit;
      ['day','month','year'].forEach(u => { const b2=g('tl-grp-'+u); if(b2) b2.classList.toggle('on', u===unit); });
      if (view === 'timeline') renderNotes();
    });
  });
  // 정렬
  g('sort-sel').addEventListener('change', () => renderNotes());

  // 검색
  g('search-inp').addEventListener('input', () => {
    // 대시보드 상태에서 검색 시 그리드 뷰로 자동 전환
    const q = (g('search-inp')?.value || '').trim();
    if (q && view === 'dash') { setView('grid'); updateFilterUI(); }
    renderNotes(); renderStats();
  });

  // 편집 모달
  g('edit-close-btn').addEventListener('click',  closeEdit);
  g('edit-cancel-btn').addEventListener('click', closeEdit);
  g('save-btn').addEventListener('click', saveNote);
  g('edit-ov').addEventListener('click', e => { if (e.target === g('edit-ov')) closeEdit(false); });

  // 내용 입력 시 태그 자동 추출 (Quill 미사용 폴백)
  g('e-content').addEventListener('input', function() {
    if (quillInst) return; // Quill이 처리함
    const newTags = extractTags(this.value);
    newTags.forEach(t => { if (!eTags.includes(t)) eTags.push(t); });
    renderTagPre();
  });

  // 링크 추가
  g('add-link-btn').addEventListener('click', addLink);

  // 태그 입력란 이벤트
  const tagInp = g('tag-inp');
  const tagWrap = g('tag-input-wrap');
  if (tagInp) {
    // Enter / 쉼표 / 공백 → 태그 추가
    tagInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
        e.preventDefault();
        const val = tagInp.value.trim();
        if (val) { addTag(val); tagInp.value = ''; }
      } else if (e.key === 'Backspace' && tagInp.value === '' && eTags.length) {
        // 입력창 비어있고 백스페이스 → 마지막 태그 삭제
        eTags.pop();
        renderTagInput();
      }
    });
    // 포커스 해제 시 남은 텍스트 처리
    tagInp.addEventListener('blur', () => {
      const val = tagInp.value.trim();
      if (val) { addTag(val); tagInp.value = ''; }
    });
    // 랩 클릭 시 입력창 포커스
    if (tagWrap) tagWrap.addEventListener('click', () => tagInp.focus());
  }

  // 상세 모달
  g('det-close-btn').addEventListener('click', closeDet);
  g('det-ov').addEventListener('click', e => { if (e.target === g('det-ov')) closeDet(); });

  // ── 필터 칩
  const fcLink = g('fc-link');
  if (fcLink) fcLink.addEventListener('click', () => {
    filterLink = !filterLink; updateFilterUI(); renderNotes(); renderStats();
  });
  const fcWeek = g('fc-week');
  if (fcWeek) fcWeek.addEventListener('click', () => {
    filterPeriod = filterPeriod==='week' ? '' : 'week'; updateFilterUI(); renderNotes(); renderStats();
  });
  const fcMonth = g('fc-month');
  if (fcMonth) fcMonth.addEventListener('click', () => {
    filterPeriod = filterPeriod==='month' ? '' : 'month'; updateFilterUI(); renderNotes(); renderStats();
  });
  const chipClear = g('chip-clear');
  if (chipClear) chipClear.addEventListener('click', clearFilters);

  // ── 대시보드는 사이드바 nav-dash 버튼으로만 접근
  const _eq=g('nav-quote');   if(_eq)_eq.addEventListener('click',()=>goNav('quote'));
  const _es=g('nav-starred'); if(_es)_es.addEventListener('click',()=>goNav('starred'));
  const _eu=g('nav-uncat');   if(_eu)_eu.addEventListener('click',()=>goNav('uncat'));
  const _ed=g('nav-dash');    if(_ed)_ed.addEventListener('click',()=>{nav='all';setView('dash');renderTitle();renderChipBar();renderStats();});

  // ── 설정 패널
  const settingsBtn = g('settings-btn');
  const settingsPanel = g('settings-panel');
  const backupBtn = g('backup-btn');
  const backupPanel = g('backup-panel');

  if (settingsBtn) settingsBtn.addEventListener('click', () => {
    settingsBtn.classList.toggle('on');
    settingsPanel.classList.toggle('hidden');
    if (backupPanel) backupPanel.classList.add('hidden');
    if (backupBtn) backupBtn.classList.remove('on');
  });
  if (backupBtn) backupBtn.addEventListener('click', () => {
    backupBtn.classList.toggle('on');
    backupPanel.classList.toggle('hidden');
    if (settingsPanel) settingsPanel.classList.add('hidden');
    if (settingsBtn) settingsBtn.classList.remove('on');
  });

  // 페이지당 수
  const spPerPage = g('sp-per-page');
  if (spPerPage) {
    spPerPage.value = String(perPage);
    spPerPage.addEventListener('change', () => {
      perPage = parseInt(spPerPage.value);
      localStorage.setItem('cfg_perPage', perPage);
      curPage = 1;
      renderNotes(); renderStats();
    });
  }
  // 스크롤/페이지 모드
  const spScroll = g('sp-scroll'), spPage = g('sp-page');
  function updateScrollModeUI() {
    if (spScroll) spScroll.classList.toggle('on', scrollMode === 'scroll');
    if (spPage)   spPage.classList.toggle('on',   scrollMode === 'page');
  }
  updateScrollModeUI();
  if (spScroll) spScroll.addEventListener('click', () => {
    scrollMode = 'scroll'; localStorage.setItem('cfg_scrollMode', scrollMode);
    updateScrollModeUI(); curPage = 1; renderNotes();
  });
  if (spPage) spPage.addEventListener('click', () => {
    scrollMode = 'page'; localStorage.setItem('cfg_scrollMode', scrollMode);
    updateScrollModeUI(); curPage = 1; renderNotes();
  });

  // 페이지 이전/다음
  const pgPrev = g('pg-prev'), pgNext = g('pg-next');
  if (pgPrev) pgPrev.addEventListener('click', () => { curPage--; renderNotes(); window.scrollTo(0,0); });
  if (pgNext) pgNext.addEventListener('click', () => { curPage++; renderNotes(); window.scrollTo(0,0); });

  // ── 백업 내보내기
  const exportBtn = g('export-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportData);

  // ── 백업 불러오기
  const importFile = g('import-file');
  if (importFile) importFile.addEventListener('change', importData);

  // ── 명언 모달은 openQuote() 호출 시 동적 생성 → 별도 바인딩 불필요

  // ── 추천요리 새로고침
  const recipeRefresh = g('sb-recipe-refresh');
  if (recipeRefresh) recipeRefresh.addEventListener('click', () => renderSidebarRecipe(true));

  // ── Quill 에디터 높이 드래그 리사이즈
  initQuillResize();
}


// ══════════════════════════════════════════════════════
// 임시보관 (Draft)
// ══════════════════════════════════════════════════════
const DRAFT_KEY = 'memo_draft';
let draftTimer  = null;

function saveDraft() {
  const title   = g('e-title')?.value || '';
  const content = g('e-content')?.value || '';
  if (!title && !content) return;
  const draft = {
    id:      editId,
    title,
    content,
    catId:   g('e-cat')?.value || '',
    savedAt: Date.now()
  };
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  const badge = g('draft-badge');
  if (badge) badge.classList.remove('hidden');
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
  const badge = g('draft-badge');
  if (badge) badge.classList.add('hidden');
}

function loadDraftIfExists() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return false;
  try {
    const draft = JSON.parse(raw);
    const ago   = Math.round((Date.now() - draft.savedAt) / 60000);
    const ok = confirm(ago + '분 전 임시저장본이 있습니다.\n제목: [' + (draft.title||'없음') + ']\n불러올까요?');
    if (!ok) { clearDraft(); return false; }
    if (g('e-title')) g('e-title').value = draft.title || '';
    if (draft.catId && g('e-cat')) g('e-cat').value = draft.catId;
    setQuillContent(draft.content || '');
    const badge = g('draft-badge');
    if (badge) badge.classList.remove('hidden');
    return true;
  } catch { return false; }
}

function startDraftTimer() {
  stopDraftTimer();
  draftTimer = setInterval(saveDraft, 30000); // 30초마다 저장
}

function stopDraftTimer() {
  if (draftTimer) { clearInterval(draftTimer); draftTimer = null; }
}

// ══════════════════════════════════════════════════════
// 백업 / 복원
// ══════════════════════════════════════════════════════
async function exportData() {
  const data = {
    version:    1,
    exportedAt: new Date().toISOString(),
    notes:      notes.map(n => ({ ...n })),
    trashed:    trashed.map(n => ({ ...n })),
    categories: cats.map(c => ({ ...c }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `memo_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('백업 파일이 다운로드되었습니다.', 'ok');
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  const status = g('import-status');
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.notes || !Array.isArray(data.notes)) throw new Error('올바른 백업 파일이 아닙니다.');
    const ok = confirm(`백업 파일에서 메모 ${data.notes.length}개, 카테고리 ${(data.categories||[]).length}개를 가져옵니다.\n\n기존 데이터와 병합됩니다. 계속할까요?`);
    if (!ok) { e.target.value = ''; return; }
    if (status) status.textContent = '가져오는 중...';
    let added = 0;
    // 메모 가져오기 (id 중복 제외)
    const existIds = new Set(notes.map(n => n._id));
    for (const n of data.notes) {
      if (existIds.has(n._id)) continue;
      const ref = doc(colNotes(), n._id);
      await setDoc(ref, {
        title:     n.title || '',
        content:   n.content || '',
        tags:      n.tags || [],
        links:     n.links || [],
        category:  n.category || '',
        starred:   n.starred || false,
        createdAt: n.createdAt || new Date().toISOString(),
        updatedAt: n.updatedAt || new Date().toISOString(),
      });
      added++;
    }
    // 카테고리 가져오기
    let catAdded = 0;
    const existCatIds = new Set(cats.map(c => c._id));
    for (const c of (data.categories || [])) {
      if (existCatIds.has(c._id)) continue;
      await setDoc(doc(colCats(), c._id), { name: c.name || '카테고리' });
      catAdded++;
    }
    if (status) status.textContent = `완료! 메모 ${added}개, 카테고리 ${catAdded}개 추가됨`;
    toast(`메모 ${added}개 가져오기 완료!`, 'ok');
    await loadData();
  } catch (err) {
    if (status) status.textContent = '오류: ' + err.message;
    toast('가져오기 실패: ' + err.message, 'err');
  }
  e.target.value = '';
}

function initQuillResize() {
  const handle   = g('quill-resize-handle');
  const wrap     = g('quill-wrap');
  if (!handle || !wrap) return;

  let startY   = 0;
  let startH   = 0;
  const MIN_H  = 100;
  const MAX_H  = 700;
  const PREF_KEY = 'quill_editor_height';

  function applyHeight(h) {
    const clamped   = Math.min(MAX_H, Math.max(MIN_H, h));
    const container = wrap.querySelector('.ql-container');
    if (container) {
      // setProperty로 !important 우선순위 덮어씀
      container.style.setProperty('height', clamped + 'px', 'important');
    }
    wrap.dataset.h = clamped;
  }

  // 저장된 높이 복원 (약간 지연 — initQuill 완료 후)
  setTimeout(() => {
    const saved = localStorage.getItem(PREF_KEY);
    if (saved) applyHeight(parseInt(saved));
  }, 100);

  function onMove(e) {
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    applyHeight(startH + (clientY - startY));
  }

  function onEnd() {
    handle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend',  onEnd);
    if (wrap.dataset.h) localStorage.setItem(PREF_KEY, wrap.dataset.h);
  }

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startY = e.clientY;
    const container = wrap.querySelector('.ql-container');
    startH = container ? container.offsetHeight : 280;
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onEnd);
  });

  handle.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    const container = wrap.querySelector('.ql-container');
    startH = container ? container.offsetHeight : 280;
    handle.classList.add('dragging');
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend',  onEnd);
  }, { passive: true });
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
    showRandomQuoteBanner();
    renderSidebarRecipe(false);
  } else {
    // 로그아웃 상태
    me = null; notes = []; trashed = []; cats = []; quotes = [];
    g('login-screen').classList.remove('hidden');
    g('loading-screen').classList.add('hidden');
    g('user-chip').classList.add('hidden');
    g('logout-btn').classList.add('hidden');
  }
});

// DOM 준비 후 이벤트 바인딩
bindEvents();
