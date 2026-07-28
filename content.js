// content.js — 掃描網頁段落、批次送翻譯、插入譯文、可還原
(() => {
  if (window.__gtLoaded) return; // 避免重複注入
  window.__gtLoaded = true;

  const SELECTOR =
    'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, figcaption, caption, summary';
  const SKIP_CLOSEST =
    'script, style, code, pre, noscript, textarea, svg, .gt-translation, [contenteditable="true"]';
  const TRANS_CLASS = 'gt-translation';

  const MAX_ITEMS = 20;   // 每批最多幾段
  const MAX_CHARS = 3000; // 每批最多字元數
  const FLUSH_DELAY = 350;

  let active = false;
  let observer = null;
  let settings = null;
  let flushTimer = null;
  const pending = new Set();   // 待翻譯的 unit
  const elUnits = new Map();   // el -> unit[]（供 IntersectionObserver 用）

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'TOGGLE') {
      toggle().then((state) => sendResponse({ state }));
      return true;
    }
    if (msg.type === 'GET_STATE') {
      sendResponse({ state: active });
    }
  });

  async function toggle() {
    if (active) { restore(); return 'off'; }
    return start();
  }

  async function start() {
    settings = await getSettings();
    if (!settings.apiKey) {
      toast('請先到擴充功能的「選項」頁面填入 Gemini API key。');
      chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      return 'need-key';
    }
    active = true;
    badge('…', '#f9ab00');
    buildUnits();
    const total = [...elUnits.values()].reduce((a, u) => a + u.length, 0);
    if (total === 0) {
      toast('這個頁面找不到可翻譯的文字段落。');
      badge('', '');
      active = false;
      return 'empty';
    }
    observer = new IntersectionObserver(onIntersect, { rootMargin: '300px 0px' });
    for (const el of elUnits.keys()) observer.observe(el);
    return 'on';
  }

  function restore() {
    active = false;
    if (observer) observer.disconnect();
    observer = null;
    pending.clear();
    elUnits.clear();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    document.querySelectorAll('.' + TRANS_CLASS).forEach((n) => n.remove());
    badge('', '');
  }

  // ---- 建立可翻譯單元 ----
  function buildUnits() {
    elUnits.clear();
    for (const el of collectLeaves()) {
      const units = segment(el);
      if (units.length) elUnits.set(el, units);
    }
  }

  // 找出「葉子」段落：本身有文字、且不包含其他候選段落
  function collectLeaves() {
    const all = [...document.querySelectorAll(SELECTOR)].filter(
      (el) => !el.closest(SKIP_CLOSEST) && isVisible(el) && el.textContent.trim().length > 1
    );
    const set = new Set(all);
    return all.filter((el) => ![...el.querySelectorAll(SELECTOR)].some((c) => set.has(c)));
  }

  // 把一個葉子切成段落單元；老網站用 <br><br> 分段也能逐段處理
  function segment(el) {
    const brCount = el.getElementsByTagName('br').length;

    // 一般情況：整塊當一段
    if (brCount < 2) {
      const text = getText(el);
      if (!translatable(text)) return [];
      return [makeUnit(el, text, (t) => el.appendChild(mkSpan(t)))];
    }

    // <br> 分段：依文字節點順序累積，遇到 <br> 就切一段，譯文插在該 <br> 前
    const units = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let buf = '';
    let node;
    const push = (anchorBr) => {
      const text = buf.trim();
      buf = '';
      if (!translatable(text)) return;
      units.push(
        makeUnit(el, text, (t) => {
          if (anchorBr && anchorBr.parentNode) anchorBr.parentNode.insertBefore(mkSpan(t), anchorBr);
          else el.appendChild(mkSpan(t)); // 最後一段：接在整塊尾端
        })
      );
    };
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        buf += node.nodeValue;
      } else if (node.nodeName === 'BR') {
        if (buf.trim()) push(node); // 只在累積到文字後才切段（連續 <br> 不會產生空段）
      }
    }
    if (buf.trim()) push(null);
    return units;
  }

  function makeUnit(el, text, insert) {
    return { el, text, insert, queued: false, done: false };
  }

  function mkSpan(text) {
    const span = document.createElement('span');
    span.className = TRANS_CLASS; // CSS 設 display:block；用 span 放進 p/font 都合法
    span.textContent = text;
    return span;
  }

  // ---- 進畫面 → 排隊 → 批次翻譯 ----
  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      for (const u of elUnits.get(entry.target) || []) {
        if (!u.queued && !u.done) { u.queued = true; pending.add(u); }
      }
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; flush(); }, FLUSH_DELAY);
  }

  async function flush() {
    if (!active || pending.size === 0) return;
    const items = [...pending];
    pending.clear();

    const batches = [];
    let cur = [];
    let chars = 0;
    for (const u of items) {
      if (cur.length >= MAX_ITEMS || (chars + u.text.length > MAX_CHARS && cur.length)) {
        batches.push(cur); cur = []; chars = 0;
      }
      cur.push(u);
      chars += u.text.length;
    }
    if (cur.length) batches.push(cur);

    for (const batch of batches) {
      if (!active) return;
      await translateBatch(batch);
    }
    if (active && pending.size > 0) scheduleFlush();
  }

  async function translateBatch(batch) {
    const texts = batch.map((u) => u.text);
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE', texts, target: settings.targetLang, model: settings.model
      });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }

    if (!res || !res.ok) {
      toast('翻譯失敗：' + (res ? res.error : '未知錯誤'));
      batch.forEach((u) => { u.queued = false; }); // 可之後重試
      badge('!', '#d93025');
      return;
    }

    batch.forEach((u, i) => {
      const t = res.translations[i];
      if (!t || u.done) return;
      try { u.insert(String(t)); u.done = true; }
      catch (e) { console.warn('[GT] insert failed', e); }
    });
  }

  // ---- 工具函式 ----
  function getText(el) {
    return (el.innerText || el.textContent || '').trim();
  }

  function translatable(t) {
    if (!t || t.length < 2) return false;
    if (!/\p{L}/u.test(t)) return false;        // 純數字 / 符號跳過
    if (isMostlyCJK(t)) return false;           // 已是中文就跳過
    return true;
  }

  function isMostlyCJK(s) {
    const han = (s.match(/\p{Script=Han}/gu) || []).length;
    const letters = (s.match(/\p{L}/gu) || []).length;
    return letters > 0 && han / letters > 0.7;
  }

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  async function getSettings() {
    const s = await chrome.storage.local.get(['apiKey', 'model', 'targetLang']);
    return {
      apiKey: s.apiKey || '',
      model: s.model || 'gemini-flash-lite-latest',
      targetLang: s.targetLang || '繁體中文'
    };
  }

  function badge(text, color) {
    chrome.runtime.sendMessage({ type: 'BADGE', text, color }).catch(() => {});
  }

  let toastEl = null;
  let toastTimer = null;
  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'gt-toast';
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.style.opacity = '0'; }, 4000);
  }
})();
