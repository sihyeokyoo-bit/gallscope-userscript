// ==UserScript==
// @name         디시인사이드 갤스코프 Mobile Pro
// @name:ko      디시인사이드 갤스코프 Mobile Pro
// @namespace    https://chatgpt.com/gallscope-mobile-pro
// @version      1.3.0
// @description  디시 모바일용 갤 분석, 작성자 분석/차단, 글 미리보기, 실시간 감지, 키워드/시간대 분석, Gemini 요약
// @description:ko 디시 모바일용 갤 분석, 작성자 분석/차단, 글 미리보기, 실시간 감지, 키워드/시간대 분석, Gemini 요약
// @match        https://m.dcinside.com/board/*
// @match        https://m.dcinside.com/mini/*
// @match        https://m.dcinside.com/person/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      generativelanguage.googleapis.com
// @updateURL    https://raw.githubusercontent.com/sihyeokyoo-bit/gallscope-userscript/main/Gallscope_Mobile_Pro.user.js
// @downloadURL  https://raw.githubusercontent.com/sihyeokyoo-bit/gallscope-userscript/main/Gallscope_Mobile_Pro.user.js
// @run-at       document-end
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * Gallscope Mobile Pro v1.3.0
 * - Mobile-first reimplementation inspired by the MIT-licensed Gallscope project.
 * - Gemini API mode. API keys are stored in the userscript manager storage (GM_setValue), not in this public file.
 * - The key is never written to localStorage or included in share/export output.
 */

(() => {
  'use strict';

  const APP = 'gsmp';
  const STORE_KEY = 'gallscope_mobile_pro_v1';
  const MAX_SCAN_PAGES = 10;
  const MAX_AI_POSTS = 80;
  const VERSION = '1.3.0';
  const GEMINI_KEY_STORE = 'gallscope_gemini_api_key';

  if (document.getElementById(`${APP}-fab`)) return;
  const route = parseRoute(location.pathname);
  if (!route) return;

  const galleryKey = `${route.kind}:${route.galleryId}`;
  const store = loadStore();
  const cfg = getGalleryConfig();

  const state = {
    open: false,
    loading: false,
    route,
    galleryKey,
    posts: [],
    stats: null,
    keywordStats: null,
    timeStats: null,
    pages: cfg.pages,
    userPages: cfg.userPages,
    liveTimer: null,
    liveSeen: new Set(),
    liveNew: 0,
    lastLiveAt: 0,
    activeTab: 'overview',
    previewCache: new Map(),
    aiText: '',
    suppressClickUntil: 0,
  };

  injectStyle();
  const ui = buildUI();
  wireUI();
  enhanceCurrentList();
  applyRulesToCurrentList();
  startDomObserver();
  startLiveIfNeeded();

  function defaultStore() {
    return {
      version: 1,
      global: {
        model: 'gemini-3.8-flash',
        rules: [],
      },
      galleries: {},
    };
  }

  function loadStore() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return defaultStore();
      parsed.global ||= {};
      if (!parsed.global.model || /^gpt-/i.test(parsed.global.model) || parsed.global.model === 'gemini-3.6-flash') parsed.global.model = 'gemini-3.8-flash';
      parsed.global.rules = Array.isArray(parsed.global.rules) ? parsed.global.rules : [];
      parsed.galleries ||= {};
      return parsed;
    } catch (_) {
      return defaultStore();
    }
  }

  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (_) {}
  }

  function getGalleryConfig() {
    const saved = store.galleries[galleryKey] || {};
    return {
      pages: clampInt(saved.pages, 1, MAX_SCAN_PAGES, 3),
      userPages: clampInt(saved.userPages, 1, MAX_SCAN_PAGES, 10),
      preview: saved.preview !== false,
      live: Boolean(saved.live),
      liveInterval: [30, 60, 120, 300].includes(Number(saved.liveInterval)) ? Number(saved.liveInterval) : 60,
      hideBlocked: saved.hideBlocked !== false,
    };
  }

  function persistGalleryConfig(patch) {
    store.galleries[galleryKey] = { ...(store.galleries[galleryKey] || {}), ...patch };
    saveStore();
  }

  function injectStyle() {
    const style = document.createElement('style');
    style.id = `${APP}-style`;
    style.textContent = `
      :root{
        --gs-a:#4658d6;--gs-a2:#6574ea;--gs-bg:#fff;--gs-card:#f5f6f8;--gs-text:#16181d;
        --gs-muted:#717681;--gs-border:#e1e4e9;--gs-danger:#d83b3b;--gs-good:#168b55;--gs-warn:#b86f00;
        --gs-shadow:0 18px 55px rgba(0,0,0,.25);--gs-hi:#fff3a8;
      }
      @media(prefers-color-scheme:dark){:root{
        --gs-bg:#15161a;--gs-card:#22242a;--gs-text:#f2f3f5;--gs-muted:#a5aab4;--gs-border:#353943;
        --gs-shadow:0 18px 55px rgba(0,0,0,.55);--gs-hi:#574d15;
      }}
      #${APP}-fab{position:fixed;right:16px;bottom:calc(82px + env(safe-area-inset-bottom));width:54px;height:54px;
        border:0;border-radius:50%;z-index:2147483643;background:var(--gs-a);color:#fff;font:800 15px/1 -apple-system,BlinkMacSystemFont,sans-serif;
        box-shadow:0 5px 20px rgba(0,0,0,.3);-webkit-tap-highlight-color:transparent}
      #${APP}-fab .badge{position:absolute;right:-3px;top:-3px;min-width:19px;height:19px;padding:0 4px;border-radius:10px;background:#e63a3a;color:white;
        font-size:10px;line-height:19px;border:2px solid var(--gs-bg);display:none}
      #${APP}-backdrop{display:none;position:fixed;inset:0;z-index:2147483644;background:rgba(0,0,0,.44);backdrop-filter:blur(2px)}
      #${APP}-backdrop.open{display:block}
      #${APP}-sheet{position:absolute;left:0;right:0;bottom:0;max-height:91vh;overflow:hidden;border-radius:20px 20px 0 0;
        background:var(--gs-bg);color:var(--gs-text);box-shadow:var(--gs-shadow);font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
      .gs-scroll{max-height:calc(91vh - 104px);overflow:auto;-webkit-overflow-scrolling:touch;padding:0 15px calc(20px + env(safe-area-inset-bottom))}
      .gs-handle{width:42px;height:5px;background:var(--gs-border);border-radius:99px;margin:9px auto 10px}
      .gs-head{display:flex;align-items:flex-start;justify-content:space-between;padding:0 15px 10px;gap:10px}
      .gs-title{margin:0;font-size:20px;font-weight:850}.gs-sub{margin:4px 0 0;font-size:11px;color:var(--gs-muted)}
      .gs-close{border:0;background:none;color:var(--gs-muted);font-size:26px;padding:0 4px}
      .gs-tabs{display:flex;overflow:auto;border-top:1px solid var(--gs-border);border-bottom:1px solid var(--gs-border);padding:0 8px}
      .gs-tab{flex:0 0 auto;border:0;background:none;color:var(--gs-muted);padding:11px 10px;font-size:12px;font-weight:750;white-space:nowrap}
      .gs-tab.active{color:var(--gs-a);box-shadow:inset 0 -2px var(--gs-a)}
      .gs-panel{display:none}.gs-panel.active{display:block}
      .gs-controls{display:flex;gap:8px;margin:14px 0 10px}.gs-select,.gs-input,.gs-btn{min-height:42px;border-radius:11px;font-size:13px}
      .gs-select,.gs-input{background:var(--gs-card);color:var(--gs-text);border:1px solid var(--gs-border);padding:0 11px;box-sizing:border-box}
      .gs-select{flex:1}.gs-btn{border:0;padding:0 14px;font-weight:800}.gs-primary{background:var(--gs-a);color:#fff;flex:1.15}.gs-primary:disabled{opacity:.55}
      .gs-secondary{background:var(--gs-card);color:var(--gs-text);border:1px solid var(--gs-border)}
      .gs-danger{color:var(--gs-danger)}.gs-good{color:var(--gs-good)}.gs-muted{color:var(--gs-muted)}
      .gs-status{font-size:11.5px;line-height:1.4;color:var(--gs-muted);min-height:17px;margin:0 0 10px}.gs-status.err{color:var(--gs-danger)}
      .gs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.gs-card{background:var(--gs-card);border:1px solid var(--gs-border);border-radius:13px;padding:11px}
      .gs-label{font-size:10.5px;color:var(--gs-muted);margin-bottom:5px}.gs-value{font-size:19px;font-weight:850;letter-spacing:-.3px}.gs-note{font-size:10.5px;color:var(--gs-muted);margin-top:4px;line-height:1.35}
      .gs-section{margin-top:15px}.gs-section h3{font-size:14px;margin:0 0 8px}.gs-section h4{font-size:12px;margin:12px 0 6px;color:var(--gs-muted)}
      .gs-bar{height:9px;overflow:hidden;display:flex;border-radius:99px;background:var(--gs-border)}.gs-fixed{background:#536dfe}.gs-semi{background:#9368dc}.gs-guest{background:#9aa0aa}
      .gs-legend{display:flex;flex-wrap:wrap;gap:9px;margin-top:7px;font-size:10.5px;color:var(--gs-muted)}
      .gs-list{margin:0;padding:0;list-style:none;border:1px solid var(--gs-border);border-radius:12px;overflow:hidden}.gs-list li{display:flex;align-items:center;gap:8px;padding:9px 10px;border-bottom:1px solid var(--gs-border);font-size:12px}.gs-list li:last-child{border-bottom:0}
      .gs-rank{width:18px;color:var(--gs-muted);font-weight:800}.gs-grow{flex:1;min-width:0}.gs-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.gs-mini{font-size:10.5px;color:var(--gs-muted)}
      .gs-user-btn{border:0;background:transparent;color:var(--gs-a);font-weight:800;font-size:11px;padding:5px}
      .gs-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.gs-actions .gs-btn{flex:1;min-width:90px}
      .gs-chip-row{display:flex;flex-wrap:wrap;gap:6px}.gs-chip{border:1px solid var(--gs-border);background:var(--gs-card);border-radius:999px;padding:6px 9px;font-size:11px}.gs-chip strong{color:var(--gs-a)}
      .gs-hours{display:flex;align-items:flex-end;gap:2px;height:95px;padding:6px 0 20px;position:relative}.gs-hour{flex:1;min-width:0;background:var(--gs-a2);border-radius:3px 3px 0 0;position:relative}.gs-hour span{position:absolute;bottom:-17px;left:50%;transform:translateX(-50%);font-size:8px;color:var(--gs-muted)}
      .gs-form-row{margin:10px 0}.gs-form-row label{display:block;font-size:11px;color:var(--gs-muted);margin:0 0 5px}.gs-input{width:100%}.gs-check{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 0;border-bottom:1px solid var(--gs-border);font-size:12px}.gs-check input{width:20px;height:20px}
      .gs-warning{border:1px solid #d59b32;background:color-mix(in srgb,#d59b32 12%,transparent);border-radius:11px;padding:10px;font-size:10.5px;line-height:1.45;margin:10px 0}
      .gs-ai-out{white-space:pre-wrap;background:var(--gs-card);border:1px solid var(--gs-border);border-radius:12px;padding:11px;font-size:12px;line-height:1.55;min-height:65px}
      .gs-foot{font-size:10px;color:var(--gs-muted);line-height:1.45;margin:12px 0 0}
      #${APP}-modal-bg{display:none;position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.5);align-items:flex-end}
      #${APP}-modal-bg.open{display:flex}.gs-modal{width:100%;max-height:86vh;overflow:auto;background:var(--gs-bg);color:var(--gs-text);border-radius:18px 18px 0 0;padding:10px 15px calc(18px + env(safe-area-inset-bottom));box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}
      .gs-modal-head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.gs-modal-title{font-size:17px;font-weight:850;margin:0}.gs-modal-body{font-size:12px;line-height:1.55}.gs-preview-img{display:block;max-width:100%;height:auto;border-radius:9px;margin:8px auto;background:var(--gs-card)}
      .gs-author-action{display:inline-flex!important;align-items:center;justify-content:center;margin-left:5px!important;padding:1px 5px!important;border-radius:7px!important;border:1px solid var(--gs-border)!important;background:var(--gs-card)!important;color:var(--gs-a)!important;font-size:9px!important;font-weight:800!important;line-height:18px!important;vertical-align:middle!important}
      .gs-highlight-row{background:var(--gs-hi)!important}.gs-blocked-row{display:none!important}.gs-soft-block{opacity:.22!important}
      .gs-rule{display:flex;align-items:center;gap:7px;padding:8px 0;border-bottom:1px solid var(--gs-border);font-size:11px}.gs-rule:last-child{border-bottom:0}
      .gs-rule .gs-grow{word-break:break-all}.gs-live-pill{display:inline-block;border:1px solid var(--gs-border);border-radius:999px;padding:2px 6px;margin-left:4px;font-size:9px;color:var(--gs-muted)}
    `;
    document.head.appendChild(style);
  }

  function buildUI() {
    const fab = document.createElement('button');
    fab.id = `${APP}-fab`; fab.type = 'button'; fab.innerHTML = `GS<span class="badge" id="${APP}-badge">0</span>`;

    const backdrop = document.createElement('div');
    backdrop.id = `${APP}-backdrop`;
    backdrop.innerHTML = `
      <section id="${APP}-sheet" role="dialog" aria-modal="true">
        <div class="gs-handle"></div>
        <div class="gs-head">
          <div><h2 class="gs-title">갤스코프 Mobile Pro</h2><p class="gs-sub">${escapeHtml(route.galleryId)} · v${VERSION}<span class="gs-live-pill" id="${APP}-live-pill">LIVE OFF</span></p></div>
          <button class="gs-close" id="${APP}-close" type="button">×</button>
        </div>
        <nav class="gs-tabs">
          <button class="gs-tab active" data-tab="overview">요약</button>
          <button class="gs-tab" data-tab="trends">트렌드</button>
          <button class="gs-tab" data-tab="users">유저</button>
          <button class="gs-tab" data-tab="ai">Gemini</button>
          <button class="gs-tab" data-tab="settings">설정</button>
        </nav>
        <div class="gs-scroll">
          <section class="gs-panel active" data-panel="overview">
            <div class="gs-controls">
              <select class="gs-select" id="${APP}-pages">${[1,3,5,10].map(n=>`<option value="${n}" ${n===cfg.pages?'selected':''}>${n}페이지</option>`).join('')}</select>
              <button class="gs-btn gs-primary" id="${APP}-analyze">분석</button>
            </div>
            <p class="gs-status" id="${APP}-status">최신 목록을 분석합니다.</p>
            <div id="${APP}-overview"></div>
          </section>
          <section class="gs-panel" data-panel="trends"><div id="${APP}-trends" style="padding-top:12px"><p class="gs-status">먼저 분석을 실행하세요.</p></div></section>
          <section class="gs-panel" data-panel="users"><div id="${APP}-users" style="padding-top:12px"><p class="gs-status">먼저 분석을 실행하세요.</p></div></section>
          <section class="gs-panel" data-panel="ai">
            <div style="padding-top:12px">
              <div class="gs-warning">Gemini API 키는 이 공개 스크립트에 포함되지 않습니다. 아래에서 1회 저장하면 유니콘 Pro의 유저스크립트 전용 저장소(GM_setValue)에 보관하며, 디시 localStorage에는 저장하지 않습니다.</div>
              <div class="gs-form-row"><label>Gemini API 키</label><input class="gs-input" id="${APP}-api-key" type="password" autocomplete="off" placeholder="키 입력 후 저장"></div>
              <div class="gs-actions"><button class="gs-btn gs-secondary" id="${APP}-key-save">API 키 저장</button><button class="gs-btn gs-secondary" id="${APP}-key-delete">저장 키 삭제</button></div>
              <p class="gs-status" id="${APP}-key-status">API 키 상태 확인 중…</p>
              <div class="gs-form-row"><label>Gemini 모델</label><input class="gs-input" id="${APP}-model" value="${escapeHtml(store.global.model || 'gemini-3.8-flash')}"></div>
              <div class="gs-actions"><button class="gs-btn gs-primary" id="${APP}-ai-run">Gemini로 최근 흐름 요약</button><button class="gs-btn gs-secondary" id="${APP}-ai-copy">요약 복사</button></div>
              <p class="gs-status" id="${APP}-ai-status">분석 후 최근 최대 ${MAX_AI_POSTS}개 제목과 집계 통계만 Gemini에 보냅니다.</p>
              <div class="gs-ai-out" id="${APP}-ai-out">아직 생성된 요약이 없습니다.</div>
            </div>
          </section>
          <section class="gs-panel" data-panel="settings"><div id="${APP}-settings" style="padding-top:12px"></div></section>
        </div>
      </section>`;

    const modalBg = document.createElement('div');
    modalBg.id = `${APP}-modal-bg`;
    modalBg.innerHTML = `<div class="gs-modal" id="${APP}-modal"><div class="gs-handle"></div><div class="gs-modal-head"><h3 class="gs-modal-title" id="${APP}-modal-title"></h3><button class="gs-close" id="${APP}-modal-close" type="button">×</button></div><div class="gs-modal-body" id="${APP}-modal-body"></div></div>`;

    document.body.append(fab, backdrop, modalBg);
    return {
      fab, badge: fab.querySelector(`#${APP}-badge`), backdrop, sheet: backdrop.querySelector(`#${APP}-sheet`), close: backdrop.querySelector(`#${APP}-close`),
      tabs:[...backdrop.querySelectorAll('.gs-tab')], panels:[...backdrop.querySelectorAll('.gs-panel')], pages:backdrop.querySelector(`#${APP}-pages`), analyze:backdrop.querySelector(`#${APP}-analyze`),
      status:backdrop.querySelector(`#${APP}-status`), overview:backdrop.querySelector(`#${APP}-overview`), trends:backdrop.querySelector(`#${APP}-trends`), users:backdrop.querySelector(`#${APP}-users`),
      livePill:backdrop.querySelector(`#${APP}-live-pill`), settings:backdrop.querySelector(`#${APP}-settings`), model:backdrop.querySelector(`#${APP}-model`),
      apiKey:backdrop.querySelector(`#${APP}-api-key`), keySave:backdrop.querySelector(`#${APP}-key-save`), keyDelete:backdrop.querySelector(`#${APP}-key-delete`), keyStatus:backdrop.querySelector(`#${APP}-key-status`),
      aiRun:backdrop.querySelector(`#${APP}-ai-run`), aiCopy:backdrop.querySelector(`#${APP}-ai-copy`), aiStatus:backdrop.querySelector(`#${APP}-ai-status`), aiOut:backdrop.querySelector(`#${APP}-ai-out`),
      modalBg, modal:modalBg.querySelector(`#${APP}-modal`), modalTitle:modalBg.querySelector(`#${APP}-modal-title`), modalBody:modalBg.querySelector(`#${APP}-modal-body`), modalClose:modalBg.querySelector(`#${APP}-modal-close`),
    };
  }

  function wireUI() {
    ui.fab.addEventListener('click', openSheet);
    ui.close.addEventListener('click', closeSheet);
    ui.backdrop.addEventListener('click', e => { if (e.target === ui.backdrop) closeSheet(); });
    ui.sheet.addEventListener('click', e => e.stopPropagation());
    ui.modalBg.addEventListener('click', e => { if (e.target === ui.modalBg) closeModal(); });
    ui.modal.addEventListener('click', e => e.stopPropagation());
    ui.modalClose.addEventListener('click', closeModal);
    ui.analyze.addEventListener('click', () => analyzePages(Number(ui.pages.value) || 3));
    ui.pages.addEventListener('change', () => {
      const pages = clampInt(ui.pages.value,1,MAX_SCAN_PAGES,3); persistGalleryConfig({pages}); state.pages = pages;
    });
    ui.tabs.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    ui.model.addEventListener('change', () => { store.global.model = cleanText(ui.model.value) || 'gemini-3.8-flash'; saveStore(); });
    ui.keySave.addEventListener('click', saveGeminiKeyFromInput);
    ui.keyDelete.addEventListener('click', deleteGeminiKey);
    refreshGeminiKeyStatus();
    ui.aiRun.addEventListener('click', runAiSummary);
    ui.aiCopy.addEventListener('click', async () => {
      if (!state.aiText) return setAiStatus('복사할 Gemini 요약이 없습니다.', true);
      await copyText(state.aiText); setAiStatus('Gemini 요약을 복사했습니다.');
    });
    renderSettings();
  }

  function switchTab(tab) {
    state.activeTab = tab;
    ui.tabs.forEach(x => x.classList.toggle('active', x.dataset.tab === tab));
    ui.panels.forEach(x => x.classList.toggle('active', x.dataset.panel === tab));
    if (tab === 'settings') renderSettings();
  }

  function openSheet() {
    state.open = true; ui.backdrop.classList.add('open'); document.documentElement.style.overflow = 'hidden';
    if (!state.stats) analyzePages(state.pages).catch(()=>{});
  }
  function closeSheet() { state.open=false; ui.backdrop.classList.remove('open'); document.documentElement.style.overflow=''; }
  function openModal(title, html) { ui.modalTitle.textContent = title; ui.modalBody.innerHTML = html; ui.modalBg.classList.add('open'); }
  function closeModal() { ui.modalBg.classList.remove('open'); }

  async function analyzePages(pages, opts={}) {
    if (state.loading) return;
    pages = clampInt(pages, 1, MAX_SCAN_PAGES, 3);
    state.loading = true; ui.analyze.disabled = true; setStatus('목록을 불러오는 중…');
    try {
      const posts = await fetchPostsPages(pages, (p)=>setStatus(`${pages}페이지 중 ${p}페이지 불러오는 중…`));
      if (!posts.length) throw new Error('분석 가능한 일반 게시글을 찾지 못했습니다.');
      state.posts = posts;
      state.pages = pages;
      state.stats = calculateStats(posts);
      state.keywordStats = calculateKeywordStats(posts);
      state.timeStats = calculateTimeStats(posts);
      state.liveSeen = new Set(posts.slice(0, 150).map(p=>p.no));
      renderAll();
      setStatus(`${posts.length}개 게시글 분석 완료 · ${pages}페이지`);
      if (!opts.silent) { enhanceCurrentList(); applyRulesToCurrentList(); }
    } catch (err) {
      console.error('[Gallscope Mobile Pro]', err); setStatus(`분석 실패: ${err?.message || err}`, true);
      throw err;
    } finally { state.loading=false; ui.analyze.disabled=false; }
  }

  async function fetchPostsPages(pages, onProgress) {
    const map = new Map();
    for (let page=1; page<=pages; page++) {
      onProgress?.(page);
      const html = await requestText(buildListUrl(page));
      const doc = new DOMParser().parseFromString(html,'text/html');
      const rows = findListRows(doc);
      if (!rows.length && page === 1) throw new Error('게시글 목록 DOM을 찾지 못했습니다.');
      for (const row of rows) {
        const post = parsePostRow(row);
        if (post && !map.has(post.no)) map.set(post.no, post);
      }
      if (page < pages) await sleep(140);
    }
    return [...map.values()].sort((a,b)=>Number(b.no)-Number(a.no));
  }

  function buildListUrl(page) {
    const section = route.kind === 'mini' ? 'mini' : route.kind === 'person' ? 'person' : 'board';
    const url = new URL(`https://m.dcinside.com/${section}/${encodeURIComponent(route.galleryId)}`);
    url.searchParams.set('page', String(page));
    return url.href;
  }

  async function requestText(url) {
    const r = await fetch(url, {method:'GET', credentials:'include', cache:'no-store', headers:{Accept:'text/html,application/xhtml+xml'}});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text(); if (!text || text.length < 300) throw new Error('빈 응답을 받았습니다.'); return text;
  }

  function findListRows(root=document) {
    const selectors = ['.gall-detail-lst .gall-detail-lnktb','.gall-detail-lst > li','li.gall-detail-lnktb','ul.gall-detail-lst li'];
    for (const s of selectors) { const arr=[...root.querySelectorAll(s)]; if (arr.length) return arr; }
    return [];
  }

  function parsePostRow(row) {
    if (!row) return null;
    const cls = String(row.className||'');
    if (/(^|\s)(ad|notice|survey)(\s|$)/i.test(cls)) return null;
    const links = [...row.querySelectorAll('a[href]')];
    let link = row.querySelector('a.lt, a.subject, a[href*="/board/"], a[href*="/mini/"], a[href*="/person/"]') || links[0];
    if (!link) return null;
    let url;
    try { url = new URL(link.getAttribute('href')||'', location.origin); } catch(_) { return null; }
    let no = '';
    const pathParts = url.pathname.split('/').filter(Boolean);
    const last = pathParts[pathParts.length-1] || '';
    if (/^\d+$/.test(last)) no = last;
    if (!no) no = url.searchParams.get('no') || row.getAttribute('data-no') || '';
    if (!/^\d+$/.test(no)) return null;

    const titleNode = link.querySelector('.subjectin,.subject,.tit') || link;
    const title = cleanText(titleNode.textContent).replace(/^\[[^\]]+\]\s*/, '');
    if (!title || /^(공지|설문|AD)$/i.test(title)) return null;
    const ginfo = row.querySelector('.ginfo,.gall-detail-info,.info') || link.querySelector('.ginfo') || row;
    const authorNode = pickAuthorNode(ginfo);
    const author = parseAuthor(authorNode || ginfo, no);
    const timestamp = parseTimestamp(ginfo);
    const infoText = cleanText(ginfo.textContent || '');
    const commentCount = parseCountFrom(row, ['.reply_num','.reply-count','.comment_num','.cmt'], /\[(\d+)\]/);
    const recommend = parseLabelNumber(infoText, /(추천|추)\s*[:：]?\s*(\d+)/i);
    const views = parseLabelNumber(infoText, /(조회|조회수)\s*[:：]?\s*(\d+)/i);

    return { no,title,url:url.href,type:author.type,key:author.key,displayName:author.displayName,nick:author.nick,uid:author.uid,ip:author.ip,timestamp,commentCount,recommend,views };
  }

  function parseCountFrom(row, selectors, fallbackRe) {
    for (const s of selectors) {
      const n=row.querySelector(s); if(n){const m=cleanText(n.textContent).match(/(\d+)/); if(m) return Number(m[1]);}
    }
    const m=cleanText(row.textContent).match(fallbackRe); return m?Number(m[1]):0;
  }
  function parseLabelNumber(text,re){const m=text.match(re);return m?Number(m[m.length-1]):0;}

  function pickAuthorNode(ginfo) {
    if (!ginfo) return null;
    const direct = [...(ginfo.children || [])].filter(n => n.tagName === 'LI');

    // DC mobile list structure: with subject = [말머리, 작성자, 시간, 조회, 추천],
    // without subject = [작성자, 시간, 조회, 추천]. This is the most reliable path.
    if (direct.length >= 5) return direct[1];
    if (direct.length === 4) return direct[0];

    const items = direct.length ? direct : [...ginfo.querySelectorAll?.('li') || []];
    let best = null, bestScore = -999;
    for (const n of items) {
      const t = cleanText(n.textContent || '');
      const html = String(n.outerHTML || '').toLowerCase();
      let score = 0;
      if (n.querySelector?.('[data-uid],[data-userid],[data-ip],a[href*="/gallog/"],a[href*="gallog.dcinside.com"]')) score += 30;
      if (/\(\d{1,3}(?:\.\d{1,3}){1,3}\)/.test(t)) score += 25;
      if (/(nickname|nick|writer|user|name)/i.test(String(n.className || ''))) score += 12;
      if (/(fix_nik|newnik|bestcon|writer_nikcon)/i.test(html)) score += 10;
      if (/^(조회|조회수|추천|댓글|작성일)\b/i.test(t)) score -= 30;
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(t) || /^\d{2}[.\/-]\d{2}/.test(t)) score -= 30;
      if (t && t.length <= 40) score += 2;
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  function parseAuthor(root, no) {
    if (!root) return {type:'guest',key:`misc:${no}`,displayName:'작성자 미확인',nick:'',uid:'',ip:''};
    const scan=[root,...(root.querySelectorAll?[...root.querySelectorAll('*')]:[])]; let uid='', ip='';
    for(const n of scan){
      if(!uid) uid=cleanText(n.getAttribute?.('data-uid')||n.getAttribute?.('data-userid')||n.getAttribute?.('data-id')||'');
      if(!ip) ip=cleanText(n.getAttribute?.('data-ip')||'');
      const href=n.getAttribute?.('href')||'';
      if(!uid && /\/gallog\//i.test(href)) uid=(href.split('/gallog/')[1]||'').split(/[/?#]/)[0];
      if(!uid && /gallog\.dcinside\.com\//i.test(href)) uid=(href.split('gallog.dcinside.com/')[1]||'').split(/[/?#]/)[0];
    }
    let raw=cleanText(root.textContent||'').replace(/^(작성자|글쓴이)\s*/i,'').trim();
    const ipMatch=raw.match(/\((\d{1,3}(?:\.\d{1,3}){1,3})\)/)||raw.match(/\b(\d{1,3}(?:\.\d{1,3}){1,3})\b/); if(!ip&&ipMatch) ip=ipMatch[1];

    const markup=String(root.outerHTML||'').toLowerCase();
    const srcs=scan.map(n=>n.getAttribute?.('src')||'').join(' ').toLowerCase();
    const fixedHint=/(fix_nik\.gif|fix_newnik\.gif|bestcon_fix\.png|fix_managernik|fix_sub_managernik)/i.test(srcs+' '+markup);
    const semiHint=/(^|[\/_-])(nik\.gif|newnik\.gif|bestcon\.png)/i.test(srcs+' '+markup) && !fixedHint;
    const hasGallog=scan.some(n=>/gallog/i.test(n.getAttribute?.('href')||''));

    let type='guest';
    if(ip) type='guest';
    else if(fixedHint) type='fixed';
    else if(semiHint) type='semi';
    else if(uid || hasGallog) type='semi'; // registered but icon not exposed: safer than treating as guest

    const nick=raw.replace(/\(\d{1,3}(?:\.\d{1,3}){1,3}\)/g,'').replace(/\b(?:\d{1,3}\.){1,3}\d{1,3}\b/g,'').replace(/\s+/g,' ').trim();
    let key=uid?`id:${uid}`:ip?`ip:${ip}`:(nick?`${type}:${nick}`:`misc:${no}`);
    let displayName=type==='guest'?(nick?`${nick}${ip?` (${ip})`:''}`:(ip||'유동')):`${nick||(type==='semi'?'반고닉':'고닉')}${uid?` (${uid})`:''}`;
    return {type,key,displayName,nick,uid,ip};
  }

  function parseTimestamp(root) {
    const vals=[]; const scan=[root,...(root.querySelectorAll?[...root.querySelectorAll('*')]:[])];
    for(const n of scan){for(const a of ['datetime','title','data-date','data-time','data-regdate']){const v=n.getAttribute?.(a);if(v)vals.push(v);}}
    if(root.querySelectorAll) vals.push(...[...root.querySelectorAll('li,time,span')].map(n=>cleanText(n.textContent)).filter(Boolean));
    for(const v of vals){const d=normalizeDate(v); if(d) return d.toISOString();} return null;
  }

  function normalizeDate(value) {
    const text=cleanText(value); let m=text.match(/(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if(m) return safeDate(+m[1],+m[2],+m[3],+m[4],+m[5],+(m[6]||0));
    const now=new Date(); m=text.match(/(?:^|\s)(\d{1,2})[.\/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
    if(m){let d=safeDate(now.getFullYear(),+m[1],+m[2],+m[3],+m[4],+(m[5]||0));if(d&&d.getTime()>now.getTime()+36*3600e3)d=safeDate(now.getFullYear()-1,+m[1],+m[2],+m[3],+m[4],+(m[5]||0));return d;}
    m=text.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s|$)/);
    if(m){let d=safeDate(now.getFullYear(),now.getMonth()+1,now.getDate(),+m[1],+m[2],+(m[3]||0));if(d&&d.getTime()>now.getTime()+10*60e3)d=new Date(d.getTime()-24*3600e3);return d;} return null;
  }
  function safeDate(y,m,d,h,mi,s){const x=new Date(y,m-1,d,h,mi,s);return Number.isFinite(x.getTime())?x:null;}

  function calculateStats(posts) {
    const total=posts.length, counts={fixed:0,semi:0,guest:0}, users=new Map();
    for(const p of posts){counts[p.type]=(counts[p.type]||0)+1; const x=users.get(p.key); if(x){x.count++;x.comments+=p.commentCount||0;x.recommend+=p.recommend||0;x.views+=p.views||0;x.posts.push(p);}else users.set(p.key,{key:p.key,name:p.displayName,type:p.type,count:1,comments:p.commentCount||0,recommend:p.recommend||0,views:p.views||0,posts:[p]});}
    const all=[...users.values()]; const originalGpi=all.reduce((s,u)=>s+Math.pow(u.count/total,2),0); const scale=Math.min(1,total/25); const multi=all.filter(u=>u.count>1); const gpi=multi.length?originalGpi*scale:0;
    const sorted=all.sort((a,b)=>b.count-a.count||b.comments-a.comments||a.name.localeCompare(b.name)); const top5=sorted.slice(0,5); const speed=calculateSpeed(posts.map(p=>p.timestamp).filter(Boolean));
    return {total,uniqueUsers:users.size,fixed:counts.fixed,semi:counts.semi,guest:counts.guest,fixedRatio:counts.fixed/total,semiRatio:counts.semi/total,guestRatio:counts.guest/total,gpi,originalGpi,top5,topUsers:sorted.slice(0,30),top5Ratio:top5.reduce((s,u)=>s+u.count,0)/total,speed,totalComments:posts.reduce((s,p)=>s+(p.commentCount||0),0)};
  }

  function calculateSpeed(raw) {
    const ts=raw.map(v=>new Date(v)).filter(d=>Number.isFinite(d.getTime())).sort((a,b)=>a-b); if(ts.length<2)return{ppm:0,insufficient:true,note:'시간 데이터 부족'};
    let f=ts,note='IQR 미적용'; if(ts.length>=5){const a=ts.map(d=>d.getTime());const q=(p)=>{const i=(p/100)*(a.length-1),l=Math.floor(i),u=Math.ceil(i),w=i-l;return a[l]*(1-w)+a[u]*w};const q1=q(25),q3=q(75),iqr=q3-q1;f=ts.filter(d=>d>=q1-iqr&&d<=q3+iqr);note=`IQR 적용${f.length<ts.length?` · 이상치 ${ts.length-f.length}개 제외`:''}`;}
    if(f.length<2)return{ppm:0,insufficient:true,note:'유효 시간 데이터 부족'}; const span=Math.max(1,(f[f.length-1]-f[0])/1000); return{ppm:(f.length/span)*60,insufficient:false,note};
  }

  function calculateKeywordStats(posts) {
    const stop=new Set('그리고 그런데 그래서 하지만 그냥 진짜 너무 이거 저거 그거 여기 거기 오늘 지금 어제 내일 하는 있는 없는 있음 없음 하면 해서 같은 이게 저게 그게 내가 니가 제가 우리 너희 ㅋㅋ ㅋㅋㅋ ㅎㅎ ㅇㅇ ㄹㅇ ㄷㄷ 왜 뭐 좀 듯 함 해도 하나 하나는 jpg jpeg png gif webp 질문 정보 후기 추천'.split(/\s+/));
    const tokenize=(s)=>cleanText(s).toLowerCase().replace(/https?:\/\/\S+/g,' ').split(/[^0-9a-z가-힣_]+/i).filter(t=>t.length>=2&&t.length<=20&&!stop.has(t)&&!/^(\d+)$/.test(t));
    const count=(arr)=>{const m=new Map();for(const p of arr)for(const t of tokenize(p.title))m.set(t,(m.get(t)||0)+1);return m;};
    const all=count(posts); const top=[...all].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,20).map(([term,n])=>({term,n}));
    const split=Math.max(1,Math.floor(posts.length*.4)); const recent=posts.slice(0,split), old=posts.slice(split); const rc=count(recent), oc=count(old); const rising=[];
    for(const [term,r] of rc){const o=oc.get(term)||0;if(r<2)continue;const rr=r/Math.max(1,recent.length),or=o/Math.max(1,old.length);const score=(rr+.006)/(or+.006);if(score>1.15)rising.push({term,recent:r,old:o,score});}
    rising.sort((a,b)=>b.score-a.score||b.recent-a.recent); return {top,rising:rising.slice(0,15)};
  }

  function calculateTimeStats(posts) {
    const hours=Array(24).fill(0), dates=[]; let recent60=0; const now=Date.now();
    for(const p of posts){if(!p.timestamp)continue;const d=new Date(p.timestamp);if(!Number.isFinite(d.getTime()))continue;hours[d.getHours()]++;dates.push(d);if(now-d.getTime()<=3600e3)recent60++;}
    const max=Math.max(...hours,0), peak=hours.indexOf(max); const valid=dates.length;
    let spanHours=0;if(dates.length>=2){dates.sort((a,b)=>a-b);spanHours=Math.max(1,(dates[dates.length-1]-dates[0])/3600e3);} const avgPerHour=valid/spanHours; const activity=avgPerHour>0?recent60/avgPerHour:0;
    return {hours,max,peak,valid,recent60,spanHours,avgPerHour,activity};
  }

  function renderAll() { renderOverview(); renderTrends(); renderUsers(); renderSettings(); updateLivePill(); }

  function renderOverview() {
    const s=state.stats;if(!s)return;const pct=v=>`${(v*100).toFixed(1)}%`;const speed=s.speed.insufficient?'측정 불가':s.speed.ppm>=1?`${s.speed.ppm.toFixed(2)}개/분`:`${(s.speed.ppm*60).toFixed(1)}개/시간`;const gpiLabel=s.gpi>=.08?'매우 집중':s.gpi>=.055?'집중 높음':s.gpi>=.04?'집중 보통':'분산됨';
    ui.overview.innerHTML=`
      <div class="gs-grid">
        <div class="gs-card"><div class="gs-label">분석 게시글</div><div class="gs-value">${s.total}</div><div class="gs-note">작성자 ${s.uniqueUsers}명 · 댓글 ${s.totalComments}</div></div>
        <div class="gs-card"><div class="gs-label">GPI</div><div class="gs-value">${(s.gpi*100).toFixed(2)}%</div><div class="gs-note">${gpiLabel} · 낮을수록 분산</div></div>
        <div class="gs-card"><div class="gs-label">상위 5명 점유율</div><div class="gs-value">${pct(s.top5Ratio)}</div><div class="gs-note">최근 ${state.pages}페이지 기준</div></div>
        <div class="gs-card"><div class="gs-label">글 리젠</div><div class="gs-value" style="font-size:16px">${speed}</div><div class="gs-note">${escapeHtml(s.speed.note)}</div></div>
      </div>
      <div class="gs-section"><h3>작성자 유형</h3><div class="gs-bar"><span class="gs-fixed" style="width:${s.fixedRatio*100}%"></span><span class="gs-semi" style="width:${s.semiRatio*100}%"></span><span class="gs-guest" style="width:${s.guestRatio*100}%"></span></div><div class="gs-legend"><span>고닉 ${s.fixed} (${pct(s.fixedRatio)})</span><span>반고닉 ${s.semi} (${pct(s.semiRatio)})</span><span>유동 ${s.guest} (${pct(s.guestRatio)})</span></div></div>
      <div class="gs-section"><h3>작성량 상위 5명</h3><ol class="gs-list">${s.top5.map((u,i)=>`<li><span class="gs-rank">${i+1}</span><span class="gs-grow gs-ellipsis">${escapeHtml(u.name)}</span><span><b>${u.count}</b> · ${pct(u.count/s.total)}</span><button class="gs-user-btn" data-user-key="${escapeAttr(u.key)}">분석</button></li>`).join('')}</ol></div>
      <div class="gs-actions"><button class="gs-btn gs-secondary" data-act="copy">결과 복사</button><button class="gs-btn gs-secondary" data-act="share">텍스트 공유</button><button class="gs-btn gs-secondary" data-act="image">이미지 공유</button></div>
      <p class="gs-foot">목록에 표시되는 공개 데이터만 집계합니다. 고닉/반고닉 구분은 디시 모바일 DOM이 바뀌면 일부 오차가 생길 수 있습니다.</p>`;
    ui.overview.querySelectorAll('[data-user-key]').forEach(b=>b.addEventListener('click',()=>showUserAnalysisByKey(b.dataset.userKey)));
    ui.overview.querySelector('[data-act="copy"]')?.addEventListener('click',async()=>{await copyText(summaryText());setStatus('결과를 복사했습니다.');});
    ui.overview.querySelector('[data-act="share"]')?.addEventListener('click',shareTextSummary);
    ui.overview.querySelector('[data-act="image"]')?.addEventListener('click',shareImageSummary);
  }

  function renderTrends() {
    if(!state.stats||!state.keywordStats||!state.timeStats)return;
    const k=state.keywordStats,t=state.timeStats;const max=t.max||1;
    const activity=t.activity>=1.8?'평소보다 매우 활발':t.activity>=1.2?'평소보다 활발':t.activity<=.55?'평소보다 조용':'평소 수준';
    ui.trends.innerHTML=`
      <div class="gs-section"><h3>시간대 분석</h3><div class="gs-grid"><div class="gs-card"><div class="gs-label">피크 시간</div><div class="gs-value">${t.valid?t.peak+'시':'-'}</div><div class="gs-note">샘플 내 게시글이 가장 많음</div></div><div class="gs-card"><div class="gs-label">최근 60분</div><div class="gs-value">${t.recent60}개</div><div class="gs-note">${escapeHtml(activity)}</div></div></div>
      <div class="gs-hours">${t.hours.map((n,h)=>`<div class="gs-hour" style="height:${Math.max(2,(n/max)*72)}px;opacity:${n?1:.18}" title="${h}시 ${n}개">${h%3===0?`<span>${h}</span>`:''}</div>`).join('')}</div></div>
      <div class="gs-section"><h3>많이 나온 키워드</h3><div class="gs-chip-row">${k.top.length?k.top.slice(0,15).map(x=>`<span class="gs-chip">${escapeHtml(x.term)} <strong>${x.n}</strong></span>`).join(''):'<span class="gs-muted">키워드 데이터 부족</span>'}</div></div>
      <div class="gs-section"><h3>급상승 키워드</h3><div class="gs-chip-row">${k.rising.length?k.rising.map(x=>`<span class="gs-chip">${escapeHtml(x.term)} <strong>×${x.score.toFixed(1)}</strong></span>`).join(''):'<span class="gs-muted">뚜렷한 급상승 키워드 없음</span>'}</div><p class="gs-foot">최신 40% 글과 이전 60% 글의 제목 출현 빈도를 비교합니다.</p></div>`;
  }

  function renderUsers() {
    const s=state.stats;if(!s)return;
    ui.users.innerHTML=`<div class="gs-section"><h3>작성자 통계</h3><ol class="gs-list">${s.topUsers.map((u,i)=>`<li><span class="gs-rank">${i+1}</span><div class="gs-grow"><div class="gs-ellipsis"><b>${escapeHtml(u.name)}</b></div><div class="gs-mini">글 ${u.count} · 댓글표시 합 ${u.comments} · 추천표시 합 ${u.recommend}</div></div><button class="gs-user-btn" data-user-key="${escapeAttr(u.key)}">상세</button></li>`).join('')}</ol></div>`;
    ui.users.querySelectorAll('[data-user-key]').forEach(b=>b.addEventListener('click',()=>showUserAnalysisByKey(b.dataset.userKey)));
  }

  async function showUserAnalysisByKey(key, parsed=null) {
    let posts=state.posts, user=(state.stats?.topUsers||[]).find(u=>u.key===key);
    if(!user || state.pages < state.userPages) {
      openModal('작성자 분석','<p class="gs-status">작성자 분석용 목록을 불러오는 중…</p>');
      try { posts=await fetchPostsPages(state.userPages); const stats=calculateStats(posts); user=stats.topUsers.find(u=>u.key===key); }
      catch(err){return openModal('작성자 분석',`<p class="gs-danger">불러오기 실패: ${escapeHtml(err.message||err)}</p>`);}
    }
    if(!user && parsed){const matched=posts.filter(p=>sameAuthor(p,parsed));if(matched.length)user={key:parsed.key,name:parsed.displayName,type:parsed.type,count:matched.length,comments:matched.reduce((s,p)=>s+p.commentCount,0),recommend:matched.reduce((s,p)=>s+p.recommend,0),views:matched.reduce((s,p)=>s+p.views,0),posts:matched};}
    if(!user) return openModal('작성자 분석','<p>현재 분석 범위에서 해당 작성자를 찾지 못했습니다.</p>');
    const up=calculateUserProfile(user.posts); const rule=getRule(user.key); const html=`
      <div class="gs-grid"><div class="gs-card"><div class="gs-label">작성글</div><div class="gs-value">${user.count}</div><div class="gs-note">최근 ${state.userPages}페이지 이내</div></div><div class="gs-card"><div class="gs-label">댓글 합</div><div class="gs-value">${user.comments||0}</div><div class="gs-note">목록에 표시된 댓글 수 합계</div></div><div class="gs-card"><div class="gs-label">추천 합</div><div class="gs-value">${user.recommend||0}</div></div><div class="gs-card"><div class="gs-label">주 활동 시간</div><div class="gs-value">${up.peakHour===null?'-':up.peakHour+'시'}</div><div class="gs-note">${up.recent60}개 / 최근 60분</div></div></div>
      <div class="gs-section"><h4>자주 쓰는 제목 단어</h4><div class="gs-chip-row">${up.keywords.length?up.keywords.map(x=>`<span class="gs-chip">${escapeHtml(x.term)} <strong>${x.n}</strong></span>`).join(''):'데이터 부족'}</div></div>
      <div class="gs-section"><h4>최근 글</h4><ol class="gs-list">${user.posts.slice(0,8).map(p=>`<li><div class="gs-grow"><div class="gs-ellipsis">${escapeHtml(p.title)}</div><div class="gs-mini">${formatDate(p.timestamp)} · 댓글 ${p.commentCount||0}</div></div><button class="gs-user-btn" data-preview-url="${escapeAttr(p.url)}">미리보기</button></li>`).join('')}</ol></div>
      <div class="gs-actions"><button class="gs-btn gs-secondary" data-uact="highlight">${rule?.mode==='highlight'?'하이라이트 해제':'하이라이트'}</button><button class="gs-btn gs-secondary" data-uact="block">${rule?.mode==='block'?'차단 해제':'차단'}</button></div>`;
    openModal(user.name,html);
    ui.modalBody.querySelectorAll('[data-preview-url]').forEach(b=>b.addEventListener('click',()=>showPostPreview(b.dataset.previewUrl)));
    ui.modalBody.querySelector('[data-uact="highlight"]')?.addEventListener('click',()=>toggleRule(user,'highlight'));
    ui.modalBody.querySelector('[data-uact="block"]')?.addEventListener('click',()=>toggleRule(user,'block'));
  }

  function calculateUserProfile(posts) {
    const ks=calculateKeywordStats(posts);const ts=calculateTimeStats(posts);return{keywords:ks.top.slice(0,8),peakHour:ts.valid?ts.peak:null,recent60:ts.recent60};
  }
  function sameAuthor(post,a){return post.key===a.key || (a.uid&&post.uid===a.uid) || (a.ip&&post.ip===a.ip);}

  function getRule(key){return (store.global.rules||[]).find(r=>r.key===key&&(!r.galleryKey||r.galleryKey===galleryKey));}
  function toggleRule(user,mode){
    const rules=store.global.rules||(store.global.rules=[]);const i=rules.findIndex(r=>r.key===user.key&&r.galleryKey===galleryKey);
    if(i>=0&&rules[i].mode===mode)rules.splice(i,1);else if(i>=0)rules[i]={...rules[i],mode,label:user.name};else rules.push({key:user.key,label:user.name,mode,galleryKey});
    saveStore();applyRulesToCurrentList();renderSettings();showUserAnalysisByKey(user.key);
  }

  function applyRulesToCurrentList() {
    const rules=store.global.rules||[]; for(const row of findListRows(document)){
      row.classList.remove('gs-highlight-row','gs-blocked-row','gs-soft-block');const p=parsePostRow(row);if(!p)continue;const r=rules.find(x=>x.key===p.key&&(!x.galleryKey||x.galleryKey===galleryKey));if(!r)continue;
      if(r.mode==='highlight')row.classList.add('gs-highlight-row');else if(r.mode==='block')row.classList.add(getGalleryConfig().hideBlocked?'gs-blocked-row':'gs-soft-block');
    }
  }

  function renderSettings() {
    const current=getGalleryConfig();const rules=(store.global.rules||[]).filter(r=>!r.galleryKey||r.galleryKey===galleryKey);
    ui.settings.innerHTML=`
      <div class="gs-section"><h3>이 갤러리 설정</h3>
        <div class="gs-check"><span>제목 길게 눌러 미리보기</span><input id="${APP}-set-preview" type="checkbox" ${current.preview?'checked':''}></div>
        <div class="gs-check"><span>실시간 새 글 감지</span><input id="${APP}-set-live" type="checkbox" ${current.live?'checked':''}></div>
        <div class="gs-form-row"><label>실시간 확인 간격</label><select class="gs-input" id="${APP}-set-interval">${[[30,'30초'],[60,'1분'],[120,'2분'],[300,'5분']].map(([n,t])=>`<option value="${n}" ${current.liveInterval===n?'selected':''}>${t}</option>`).join('')}</select></div>
        <div class="gs-form-row"><label>작성자 상세 분석 범위</label><select class="gs-input" id="${APP}-set-userpages">${[3,5,10].map(n=>`<option value="${n}" ${current.userPages===n?'selected':''}>최근 ${n}페이지</option>`).join('')}</select></div>
        <div class="gs-check"><span>차단 작성자 완전히 숨기기</span><input id="${APP}-set-hide" type="checkbox" ${current.hideBlocked?'checked':''}></div>
      </div>
      <div class="gs-section"><h3>차단 / 하이라이트</h3>${rules.length?rules.map((r,i)=>`<div class="gs-rule"><span class="gs-grow">${r.mode==='block'?'차단':'강조'} · ${escapeHtml(r.label||r.key)}</span><button class="gs-user-btn" data-rule-del="${i}">삭제</button></div>`).join(''):'<p class="gs-status">등록된 작성자가 없습니다. 작성자 분석 화면에서 추가할 수 있습니다.</p>'}</div>
      <div class="gs-section"><h3>데이터</h3><div class="gs-actions"><button class="gs-btn gs-secondary" id="${APP}-reset-gallery">현재 갤 설정 초기화</button><button class="gs-btn gs-secondary gs-danger" id="${APP}-reset-rules">현재 갤 규칙 삭제</button></div></div>`;
    const q=s=>ui.settings.querySelector(s);
    q(`#${APP}-set-preview`)?.addEventListener('change',e=>{persistGalleryConfig({preview:e.target.checked});enhanceCurrentList(true);});
    q(`#${APP}-set-live`)?.addEventListener('change',e=>{persistGalleryConfig({live:e.target.checked});startLiveIfNeeded();renderSettings();});
    q(`#${APP}-set-interval`)?.addEventListener('change',e=>{persistGalleryConfig({liveInterval:Number(e.target.value)});startLiveIfNeeded();});
    q(`#${APP}-set-userpages`)?.addEventListener('change',e=>{state.userPages=Number(e.target.value);persistGalleryConfig({userPages:state.userPages});});
    q(`#${APP}-set-hide`)?.addEventListener('change',e=>{persistGalleryConfig({hideBlocked:e.target.checked});applyRulesToCurrentList();});
    ui.settings.querySelectorAll('[data-rule-del]').forEach(b=>b.addEventListener('click',()=>{const visible=(store.global.rules||[]).filter(r=>!r.galleryKey||r.galleryKey===galleryKey);const target=visible[Number(b.dataset.ruleDel)];store.global.rules=(store.global.rules||[]).filter(r=>r!==target);saveStore();applyRulesToCurrentList();renderSettings();}));
    q(`#${APP}-reset-gallery`)?.addEventListener('click',()=>{delete store.galleries[galleryKey];saveStore();location.reload();});
    q(`#${APP}-reset-rules`)?.addEventListener('click',()=>{store.global.rules=(store.global.rules||[]).filter(r=>r.galleryKey&&r.galleryKey!==galleryKey);saveStore();applyRulesToCurrentList();renderSettings();});
  }

  function enhanceCurrentList(force=false) {
    const current=getGalleryConfig();
    for(const row of findListRows(document)){
      const p=parsePostRow(row);if(!p)continue;
      const info=row.querySelector('.ginfo,.gall-detail-info,.info')||row;
      if(force) row.querySelectorAll(`.${APP}-author-action`).forEach(x=>x.remove());
      if(!row.querySelector(`.${APP}-author-action`)){
        const b=document.createElement('button');b.type='button';b.className=`${APP}-author-action gs-author-action`;b.textContent='GS';b.title='작성자 분석';
        b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();showUserAnalysisByKey(p.key,p);});info.appendChild(b);
      }
      const title=findTitleAnchor(row,p.url); if(current.preview&&title&&!title.dataset.gsPreview){title.dataset.gsPreview='1';attachLongPress(title,p.url,p.title);}
    }
  }

  function findTitleAnchor(row,url){const a=[...row.querySelectorAll('a[href]')].find(x=>{try{const u=new URL(x.href,location.origin);return u.href===url;}catch(_){return false;}});return a||row.querySelector('a.lt,a.subject');}
  function attachLongPress(el,url,title){
    let timer=null,triggered=false,startX=0,startY=0;
    const clear=()=>{if(timer){clearTimeout(timer);timer=null;}};
    el.addEventListener('touchstart',e=>{const t=e.touches?.[0];startX=t?.clientX||0;startY=t?.clientY||0;triggered=false;clear();timer=setTimeout(()=>{triggered=true;state.suppressClickUntil=Date.now()+900;navigator.vibrate?.(18);showPostPreview(url,title);},520);},{passive:true});
    el.addEventListener('touchmove',e=>{const t=e.touches?.[0];if(t&&Math.hypot((t.clientX||0)-startX,(t.clientY||0)-startY)>14)clear();},{passive:true});
    el.addEventListener('touchend',clear,{passive:true});el.addEventListener('touchcancel',clear,{passive:true});
    el.addEventListener('click',e=>{if(triggered||Date.now()<state.suppressClickUntil){e.preventDefault();e.stopPropagation();triggered=false;}},true);
  }

  async function showPostPreview(url,fallbackTitle='글 미리보기') {
    openModal(fallbackTitle,'<p class="gs-status">본문을 불러오는 중…</p>');
    try{
      let data=state.previewCache.get(url);if(!data){const html=await requestText(url);data=parsePostDetail(html,url);state.previewCache.set(url,data);if(state.previewCache.size>30)state.previewCache.delete(state.previewCache.keys().next().value);}
      const imgs=data.images.slice(0,6).map(src=>`<img class="gs-preview-img" loading="lazy" referrerpolicy="no-referrer" src="${escapeAttr(src)}">`).join('');
      openModal(data.title||fallbackTitle,`<div class="gs-mini">${escapeHtml(data.meta)}</div><p style="white-space:pre-wrap;word-break:break-word">${escapeHtml(data.text||'본문 텍스트를 추출하지 못했습니다.')}</p>${imgs}<div class="gs-actions"><button class="gs-btn gs-secondary" data-open-full>원문 열기</button></div>`);
      ui.modalBody.querySelector('[data-open-full]')?.addEventListener('click',()=>{location.href=url;});
    }catch(err){openModal(fallbackTitle,`<p class="gs-danger">미리보기 실패: ${escapeHtml(err.message||err)}</p><div class="gs-actions"><button class="gs-btn gs-secondary" data-open-full>원문 열기</button></div>`);ui.modalBody.querySelector('[data-open-full]')?.addEventListener('click',()=>{location.href=url;});}
  }

  function parsePostDetail(html,url){
    const doc=new DOMParser().parseFromString(html,'text/html');
    const title=cleanText(doc.querySelector('.view-title,.tit_view,.title_subject,.gallview_head .title,.view_subject,h1,h2')?.textContent||doc.title||'');
    const selectors=['.thum-txtin','.writing_view_box','.write_div','.gallview_contents','.view_content_wrap','.usertxt','#dgn_content_de','.view_content'];let body=null;
    for(const s of selectors){const n=doc.querySelector(s);if(n&&cleanText(n.textContent).length){body=n;break;}}
    if(!body){const candidates=[...doc.querySelectorAll('article,.view_content,.gallview_contents,section')].sort((a,b)=>cleanText(b.textContent).length-cleanText(a.textContent).length);body=candidates[0]||doc.body;}
    const clone=body.cloneNode(true);clone.querySelectorAll('script,style,noscript,iframe,form,button').forEach(n=>n.remove());let text=cleanText(clone.textContent||'');if(text.length>2400)text=text.slice(0,2400)+'…';
    const images=[...body.querySelectorAll('img')].map(img=>img.getAttribute('data-original')||img.getAttribute('data-src')||img.getAttribute('src')||'').map(src=>{try{return new URL(src,url).href}catch(_){return''}}).filter(src=>/^https?:\/\//i.test(src)&&!/(icon|logo|profile|ad_|banner)/i.test(src));
    const meta=cleanText(doc.querySelector('.gallview_head,.view_info,.ginfo,.view_top')?.textContent||'');return{title,text,images:[...new Set(images)],meta};
  }

  function startDomObserver(){let t=null;const mo=new MutationObserver(()=>{clearTimeout(t);t=setTimeout(()=>{enhanceCurrentList();applyRulesToCurrentList();},250);});const target=document.querySelector('.gall-detail-lst')||document.body;mo.observe(target,{childList:true,subtree:true});}

  function startLiveIfNeeded() {
    if(state.liveTimer){clearInterval(state.liveTimer);state.liveTimer=null;} const c=getGalleryConfig();updateLivePill(); if(!c.live)return;
    state.liveTimer=setInterval(()=>liveTick().catch(()=>{}),c.liveInterval*1000); if(!state.liveSeen.size) setTimeout(()=>liveTick().catch(()=>{}),1500);
  }

  async function liveTick(){
    try{const html=await requestText(buildListUrl(1));const doc=new DOMParser().parseFromString(html,'text/html');const posts=findListRows(doc).map(parsePostRow).filter(Boolean).sort((a,b)=>Number(b.no)-Number(a.no));if(!posts.length)return;
      if(!state.liveSeen.size){posts.forEach(p=>state.liveSeen.add(p.no));state.lastLiveAt=Date.now();updateLivePill();return;}
      const fresh=posts.filter(p=>!state.liveSeen.has(p.no));fresh.forEach(p=>state.liveSeen.add(p.no));if(fresh.length){state.liveNew+=fresh.length;state.posts=mergePosts(fresh,state.posts);if(state.posts.length){state.stats=calculateStats(state.posts);state.keywordStats=calculateKeywordStats(state.posts);state.timeStats=calculateTimeStats(state.posts);renderAll();}updateBadge();}
      state.lastLiveAt=Date.now();updateLivePill();
    }catch(err){console.warn('[Gallscope live]',err);}
  }
  function mergePosts(a,b){const m=new Map();for(const p of [...a,...b])if(p?.no&&!m.has(p.no))m.set(p.no,p);return[...m.values()].sort((x,y)=>Number(y.no)-Number(x.no)).slice(0,350);}
  function updateBadge(){ui.badge.textContent=state.liveNew>99?'99+':String(state.liveNew);ui.badge.style.display=state.liveNew?'block':'none';}
  function updateLivePill(){const c=getGalleryConfig();ui.livePill.textContent=c.live?`LIVE ${c.liveInterval}s${state.lastLiveAt?' · '+new Date(state.lastLiveAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):''}`:'LIVE OFF';}

  function readGeminiKey() {
    try {
      if (typeof GM_getValue === 'function') return String(GM_getValue(GEMINI_KEY_STORE, '') || '').trim();
    } catch (_) {}
    return '';
  }

  function writeGeminiKey(value) {
    if (typeof GM_setValue !== 'function') throw new Error('유니콘 Pro의 GM_setValue를 사용할 수 없습니다.');
    GM_setValue(GEMINI_KEY_STORE, value);
  }

  function removeGeminiKey() {
    if (typeof GM_deleteValue === 'function') GM_deleteValue(GEMINI_KEY_STORE);
    else if (typeof GM_setValue === 'function') GM_setValue(GEMINI_KEY_STORE, '');
  }

  function refreshGeminiKeyStatus(message='') {
    const hasKey = Boolean(readGeminiKey());
    if (ui?.keyStatus) {
      ui.keyStatus.textContent = message || (hasKey ? 'API 키: 유니콘 Pro 저장소에 저장됨' : 'API 키: 미설정');
      ui.keyStatus.classList.toggle('err', !hasKey && !message);
    }
  }

  function saveGeminiKeyFromInput() {
    const key = String(ui.apiKey?.value || '').trim();
    if (!key) return refreshGeminiKeyStatus('저장할 API 키를 입력하세요.');
    try {
      writeGeminiKey(key);
      ui.apiKey.value = '';
      refreshGeminiKeyStatus('API 키를 유니콘 Pro 저장소에 저장했습니다.');
    } catch (err) {
      refreshGeminiKeyStatus(`API 키 저장 실패: ${err?.message || err}`);
    }
  }

  function deleteGeminiKey() {
    try {
      removeGeminiKey();
      if (ui.apiKey) ui.apiKey.value = '';
      refreshGeminiKeyStatus('저장된 API 키를 삭제했습니다.');
    } catch (err) {
      refreshGeminiKeyStatus(`API 키 삭제 실패: ${err?.message || err}`);
    }
  }

  async function runAiSummary() {
    if(!state.posts.length){try{await analyzePages(state.pages);}catch(_){return;}}
    let apiKey=readGeminiKey();
    const typedKey=String(ui.apiKey?.value||'').trim();
    if(!apiKey && typedKey){
      try{writeGeminiKey(typedKey);ui.apiKey.value='';apiKey=typedKey;refreshGeminiKeyStatus('API 키를 저장하고 요약을 시작합니다.');}
      catch(err){return setAiStatus(`API 키 저장 실패: ${err?.message||err}`,true);}
    }
    if(!apiKey){switchTab('ai');return setAiStatus('Gemini API 키를 먼저 입력하고 저장하세요.',true);}
    const model=cleanText(ui.model.value)||'gemini-3.8-flash';store.global.model=model;saveStore();
    ui.aiRun.disabled=true;setAiStatus('Gemini 요약 생성 중… 혼잡하면 자동으로 재시도/대체 모델 전환');
    try{
      const prompt=buildAiPrompt();
      const instructions='너는 온라인 커뮤니티 흐름을 중립적으로 요약하는 분석 도우미다. 제공된 게시글 제목과 집계만 사용하고, 개인을 단정적으로 평가하거나 신원을 추정하지 않는다. 한국어로 짧고 구체적으로 쓴다.';
      const result=await geminiRequestWithFallback(model,instructions,prompt,apiKey);
      const out=extractGeminiText(result.data);if(!out)throw new Error('응답에서 텍스트를 찾지 못했습니다.');
      state.aiText=out;ui.aiOut.textContent=out;
      if(result.model!==model){ui.model.value=result.model;store.global.model=result.model;saveStore();}
      setAiStatus(`완료 · ${result.model}${result.model!==model?' (자동 전환)':''}`);
    }catch(err){console.error('[Gallscope Gemini]',err);setAiStatus(`Gemini 오류: ${err?.message||err}`,true);}finally{ui.aiRun.disabled=false;}
  }

  function buildAiPrompt(){
    const s=state.stats,k=state.keywordStats,t=state.timeStats;const titles=state.posts.slice(0,MAX_AI_POSTS).map((p,i)=>`${i+1}. ${p.title}${p.commentCount?` [댓글 ${p.commentCount}]`:''}`).join('\n');
    return `갤러리: ${route.galleryId}\n분석 범위: 최근 ${state.pages}페이지, ${state.posts.length}개 글\nGPI: ${(s.gpi*100).toFixed(2)}%\n상위 5명 점유율: ${(s.top5Ratio*100).toFixed(1)}%\n고닉/반고닉/유동: ${(s.fixedRatio*100).toFixed(1)}% / ${(s.semiRatio*100).toFixed(1)}% / ${(s.guestRatio*100).toFixed(1)}%\n피크 시간대: ${t.valid?t.peak+'시':'데이터 부족'}\n주요 키워드: ${k.top.slice(0,12).map(x=>`${x.term}(${x.n})`).join(', ')}\n급상승: ${k.rising.slice(0,8).map(x=>x.term).join(', ')||'없음'}\n\n아래 최근 게시글 제목을 바탕으로 다음 형식으로 요약해줘.\n1) 지금 가장 큰 떡밥 3개\n2) 분위기/논쟁 포인트\n3) 새로 떠오르는 키워드\n4) 한줄 요약\n\n게시글 제목:\n${titles}`;
  }

  async function geminiRequestWithFallback(preferredModel,instructions,prompt,key){
    const models=[preferredModel,'gemini-3.8-flash','gemini-3.7-flash','gemini-3.5-flash-lite']
      .map(x=>(x||'').replace(/^models\//,'').trim())
      .filter((x,i,a)=>x&&a.indexOf(x)===i);
    let lastErr=null;

    for(const model of models){
      for(let attempt=0;attempt<2;attempt++){
        try{
          const data=await geminiRequest(model,instructions,prompt,key);
          return {data,model};
        }catch(err){
          lastErr=err;
          const msg=String(err?.message||'').toLowerCase();
          const retryable=[429,500,502,503,504].includes(Number(err?.status))
            || /high demand|overloaded|temporar|resource exhausted|unavailable|rate limit|try again/.test(msg);
          if(!retryable) throw err;
          if(attempt===0) await sleep(1200);
        }
      }
    }
    throw lastErr||new Error('사용 가능한 Gemini 모델이 없습니다.');
  }

  function geminiRequest(model,instructions,prompt,key){
    const safeModel=(model||'gemini-3.8-flash').replace(/^models\//,'').trim();
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent`;
    const body={
      systemInstruction:{parts:[{text:instructions}]},
      contents:[{role:'user',parts:[{text:prompt}]}],
      generationConfig:{temperature:0.35,maxOutputTokens:900}
    };

    const makeError=(status,data,fallback)=>{
      const err=new Error(data?.error?.message||fallback||`Gemini HTTP ${status}`);
      err.status=Number(status)||0;
      return err;
    };

    if(typeof GM_xmlhttpRequest==='function')return new Promise((resolve,reject)=>{
      GM_xmlhttpRequest({
        method:'POST',url,
        headers:{'Content-Type':'application/json','x-goog-api-key':key},
        data:JSON.stringify(body),timeout:45000,
        onload:r=>{
          let data;
          try{data=JSON.parse(r.responseText)}catch(_){return reject(makeError(r.status,null,`Gemini 응답 파싱 실패 (${r.status})`));}
          if(r.status<200||r.status>=300)return reject(makeError(r.status,data));
          resolve(data);
        },
        onerror:()=>reject(makeError(0,null,'Gemini 네트워크 오류')),
        ontimeout:()=>reject(makeError(504,null,'Gemini 요청 시간 초과'))
      });
    });

    return fetch(url,{
      method:'POST',
      headers:{'Content-Type':'application/json','x-goog-api-key':key},
      body:JSON.stringify(body)
    }).then(async r=>{
      let d={};try{d=await r.json();}catch(_){}
      if(!r.ok)throw makeError(r.status,d);
      return d;
    });
  }

  function extractGeminiText(data){
    if(!data)return'';
    const parts=[];
    for(const c of data.candidates||[]){for(const p of c?.content?.parts||[]){if(typeof p?.text==='string')parts.push(p.text);}}
    return parts.join('\n').trim();
  }

  function summaryText(){
    if(!state.stats)return'[갤스코프] 분석 데이터 없음';const s=state.stats,k=state.keywordStats,t=state.timeStats;const speed=s.speed.insufficient?'측정 불가':s.speed.ppm>=1?`${s.speed.ppm.toFixed(2)}개/분`:`${(s.speed.ppm*60).toFixed(1)}개/시간`;
    return [`[갤스코프 Mobile Pro] ${route.galleryId}`,`범위: ${state.pages}페이지 / ${s.total}개 글`,`고닉 ${(s.fixedRatio*100).toFixed(1)}% · 반고닉 ${(s.semiRatio*100).toFixed(1)}% · 유동 ${(s.guestRatio*100).toFixed(1)}%`,`GPI ${(s.gpi*100).toFixed(2)}% · 상위 5명 ${(s.top5Ratio*100).toFixed(1)}%`,`글 리젠 ${speed}`,`피크 시간 ${t.valid?t.peak+'시':'-'}`,`주요 키워드: ${k.top.slice(0,10).map(x=>x.term).join(', ')}`,'','상위 작성자',...s.top5.map((u,i)=>`${i+1}. ${u.name}: ${u.count}개`)].join('\n');
  }

  async function shareTextSummary(){const text=summaryText();try{if(navigator.share)await navigator.share({title:`갤스코프 ${route.galleryId}`,text});else{await copyText(text);setStatus('공유 기능을 지원하지 않아 결과를 복사했습니다.');}}catch(err){if(err?.name!=='AbortError')setStatus('공유에 실패했습니다.',true);}}

  async function shareImageSummary(){
    if(!state.stats)return setStatus('먼저 분석을 실행하세요.',true);try{const blob=await makeSummaryImage();const file=new File([blob],`gallscope-${route.galleryId}.png`,{type:'image/png'});if(navigator.share&&navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:`갤스코프 ${route.galleryId}`});}else{const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=file.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);setStatus('이미지 파일로 저장했습니다.');}}catch(err){if(err?.name!=='AbortError')setStatus(`이미지 공유 실패: ${err.message||err}`,true);}
  }

  function makeSummaryImage(){return new Promise((resolve,reject)=>{try{const c=document.createElement('canvas');c.width=1080;c.height=1350;const x=c.getContext('2d');const dark=matchMedia('(prefers-color-scheme: dark)').matches;x.fillStyle=dark?'#15161a':'#ffffff';x.fillRect(0,0,c.width,c.height);x.fillStyle=dark?'#f4f4f5':'#111318';x.font='800 58px -apple-system, sans-serif';x.fillText('갤스코프 Mobile Pro',70,105);x.font='500 32px -apple-system, sans-serif';x.fillStyle=dark?'#b5b8c1':'#606570';x.fillText(route.galleryId,70,160);const lines=summaryText().split('\n').slice(1);let y=245;for(const line of lines){x.fillStyle=dark?'#f4f4f5':'#16181d';x.font=line==='상위 작성자'?'800 36px -apple-system, sans-serif':'500 31px -apple-system, sans-serif';const wrapped=wrapCanvasText(x,line,930);for(const w of wrapped){x.fillText(w,70,y);y+=48;}y+=line===''?10:5;if(y>1260)break;}x.fillStyle=dark?'#777c87':'#9aa0aa';x.font='400 24px -apple-system, sans-serif';x.fillText(new Date().toLocaleString('ko-KR'),70,1300);c.toBlob(b=>b?resolve(b):reject(new Error('이미지 생성 실패')),'image/png');}catch(e){reject(e);}});}
  function wrapCanvasText(ctx,text,maxWidth){const out=[];let line='';for(const ch of String(text)){const test=line+ch;if(ctx.measureText(test).width>maxWidth&&line){out.push(line);line=ch;}else line=test;}if(line)out.push(line);return out;}

  function setStatus(msg,err=false){ui.status.textContent=msg;ui.status.classList.toggle('err',!!err);}
  function setAiStatus(msg,err=false){ui.aiStatus.textContent=msg;ui.aiStatus.classList.toggle('err',!!err);}
  async function copyText(text){try{await navigator.clipboard.writeText(text);}catch(_){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();}}

  function parseRoute(path){let m=path.match(/^\/board\/([^/?#]+)/i);if(m)return{kind:'board',galleryId:decodeURIComponent(m[1])};m=path.match(/^\/mini\/([^/?#]+)/i);if(m)return{kind:'mini',galleryId:decodeURIComponent(m[1])};m=path.match(/^\/person\/([^/?#]+)/i);if(m)return{kind:'person',galleryId:decodeURIComponent(m[1])};return null;}
  function cleanText(v){return String(v??'').replace(/\s+/g,' ').trim();}
  function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
  function escapeAttr(v){return escapeHtml(v).replace(/`/g,'&#096;');}
  function clampInt(v,min,max,def){const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,Math.round(n))):def;}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
  function formatDate(v){if(!v)return'-';const d=new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString('ko-KR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'-';}
})();
