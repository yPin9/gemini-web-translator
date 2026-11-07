// content.js — 掃描網頁段落、批次送翻譯、插入譯文、可還原
(() => {
  if (window.__gtLoaded) return; // 避免重複注入
  window.__gtLoaded = true;

  const SELECTOR =
    'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dd, dt, figcaption, caption, summary';
  const SKIP_CLOSEST =
    'script, style, code, pre, noscript, textarea, svg, .gt-translation, [contenteditable="true"]';
  const TRANS_CLASS = 'gt-translation';
  const ANCHOR_CLASS = 'gt-observe-anchor';
  const PAIR_CLASS = 'gt-pair';
  const ACTIVE_PAIR_CLASS = 'gt-pair-active';
  const SOURCE_HIGHLIGHT = 'gt-source-pair';

  const MAX_ITEMS = 20;   // 每批最多幾段
  const MAX_CHARS = 3000; // 每批最多字元數
  const FLUSH_DELAY = 350;
  const RETRY_DELAY = 3000;
  const MAX_BATCH_RETRIES = 1;

  let active = false;
  let observer = null;
  let settings = null;
  let flushTimer = null;
  let runId = 0;
  let starting = false;
  const pairUnits = new Map();
  let pairSequence = 0;
  let highlightedUnit = null;
  let lockedUnit = null;
  const pending = new Set();   // 待翻譯的 unit
  const elUnits = new Map();   // el -> unit[]（供 IntersectionObserver 用）

  document.addEventListener?.('pointerover', onPairPointerOver, true);
  document.addEventListener?.('pointerout', onPairPointerOut, true);
  document.addEventListener?.('click', onPairClick, true);
  document.addEventListener?.('keydown', onPairKeyDown, true);

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
    if (active || starting) { restore(); return 'off'; }
    return start();
  }

  async function start() {
    const currentRun = ++runId;
    starting = true;
    const nextSettings = await getSettings();
    if (currentRun !== runId) return 'off';
    starting = false;
    settings = nextSettings;
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
    runId += 1;
    starting = false;
    active = false;
    if (observer) observer.disconnect();
    observer = null;
    pending.clear();
    elUnits.clear();
    pairUnits.clear();
    lockedUnit = null;
    clearPairHighlight();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    document.querySelectorAll('.' + TRANS_CLASS + ', .' + ANCHOR_CLASS).forEach((n) => n.remove());
    badge('', '');
  }

  // ---- 建立可翻譯單元 ----
  function buildUnits() {
    elUnits.clear();
    for (const el of collectLeaves()) {
      const units = segment(el);
      for (const unit of units) {
        const target = unit.observeTarget || el;
        if (!elUnits.has(target)) elUnits.set(target, []);
        elUnits.get(target).push(unit);
      }
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
      const model = buildTextModel(el);
      return makeGroupUnits(el, model, (container) => el.appendChild(container), el);
    }

    // 老式網頁常用 <br><br> 分段；單一 <br> 只是段內換行，不應拆成 API 單元。
    const paragraphs = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let text = '';
    let runs = [];
    let firstTextNode = null;
    let pendingBreaks = [];
    let node;

    const pushParagraph = (anchorBr) => {
      if (text.trim()) paragraphs.push({ model: { text, runs }, firstTextNode, anchorBr });
      text = '';
      runs = [];
      firstTextNode = null;
    };

    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.nodeValue.trim()) continue;

        if (pendingBreaks.length >= 2) {
          pushParagraph(pendingBreaks[0]);
        } else if (pendingBreaks.length === 1 && text.length > 0) {
          text += ' ';
        }
        pendingBreaks = [];

        if (!firstTextNode) firstTextNode = node;
        const start = text.length;
        text += node.nodeValue;
        runs.push({ node, start, end: text.length });
      } else if (node.nodeName === 'BR') {
        pendingBreaks.push(node);
      }
    }

    if (text.length > 0) {
      pushParagraph(pendingBreaks.length >= 2 ? pendingBreaks[0] : null);
    }

    // 每段建立自己的觀察錨點，避免一個超長 <td> 進入畫面時排入整篇文章。
    const units = [];
    for (const paragraph of paragraphs) {
      if (!translatable(paragraph.model.text)) continue;

      const observeTarget = mkObserveAnchor();
      if (paragraph.firstTextNode?.parentNode) {
        paragraph.firstTextNode.parentNode.insertBefore(observeTarget, paragraph.firstTextNode);
      } else {
        el.insertBefore(observeTarget, el.firstChild);
      }

      const place = (container) => {
        if (paragraph.anchorBr?.parentNode) {
          paragraph.anchorBr.parentNode.insertBefore(container, paragraph.anchorBr);
        } else {
          el.appendChild(container);
        }
      };
      units.push(...makeGroupUnits(el, paragraph.model, place, observeTarget));
    }
    return units;
  }

  function buildTextModel(el) {
    if (!document.createTreeWalker) return { text: getText(el), runs: [] };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const runs = [];
    let text = '';
    let node;
    while ((node = walker.nextNode())) {
      if (!node.nodeValue) continue;
      const start = text.length;
      text += node.nodeValue;
      runs.push({ node, start, end: text.length });
    }
    return { text, runs };
  }

  function splitText(text) {
    const chunks = [];
    const add = (start, end) => {
      while (start < end && /\s/.test(text[start])) start += 1;
      while (end > start && /\s/.test(text[end - 1])) end -= 1;
      if (end <= start) return;
      const value = text.slice(start, end).replace(/\s+/g, ' ').trim();
      if (translatable(value)) chunks.push({ text: value, start, end });
    };

    if (typeof Intl?.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      for (const part of segmenter.segment(text)) add(part.index, part.index + part.segment.length);
    } else {
      const pattern = /[^.!?。！？…]+(?:[.!?。！？…]+|$)\s*/gu;
      let match;
      while ((match = pattern.exec(text))) add(match.index, match.index + match[0].length);
    }
    return chunks;
  }

  function makeSourceRanges(model, start, end) {
    if (!document.createRange) return [];
    const ranges = [];
    for (const run of model.runs) {
      const overlapStart = Math.max(start, run.start);
      const overlapEnd = Math.min(end, run.end);
      if (overlapStart >= overlapEnd) continue;
      const range = document.createRange();
      range.setStart(run.node, overlapStart - run.start);
      range.setEnd(run.node, overlapEnd - run.start);
      ranges.push(range);
    }
    return ranges;
  }

  function makeGroupUnits(el, model, place, observeTarget) {
    const chunks = splitText(model.text);
    if (chunks.length === 0) return [];

    const group = { container: null, place, translations: [], units: [] };
    chunks.forEach((chunk, index) => {
      const unit = {
        el,
        text: chunk.text,
        observeTarget,
        pairId: 'gt-' + (++pairSequence),
        sourceRanges: makeSourceRanges(model, chunk.start, chunk.end),
        translationNode: null,
        queued: false,
        done: false,
        retryCount: 0
      };
      unit.insert = (translation) => {
        group.translations[index] = translation;
        renderTranslationGroup(group);
      };
      group.units.push(unit);
      pairUnits.set(unit.pairId, unit);
    });
    return group.units;
  }

  function renderTranslationGroup(group) {
    if (!group.container) {
      group.container = mkSpan();
      group.place(group.container);
    }

    const nodes = [];
    group.translations.forEach((translation, index) => {
      if (!translation) return;
      if (nodes.length && document.createTextNode) nodes.push(document.createTextNode(' '));
      const unit = group.units[index];
      const span = document.createElement('span');
      span.className = PAIR_CLASS;
      span.setAttribute('data-gt-pair', unit.pairId);
      span.textContent = translation;
      unit.translationNode = span;
      nodes.push(span);
    });

    if (group.container.replaceChildren) {
      group.container.replaceChildren(...nodes);
    } else {
      group.container.textContent = '';
      nodes.forEach((node) => group.container.appendChild(node));
    }
  }

  function mkObserveAnchor() {
    const span = document.createElement('span');
    span.className = ANCHOR_CLASS;
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  function mkSpan(text = '') {
    const span = document.createElement('span');
    span.className = TRANS_CLASS; // CSS 設 display:block；用 span 放進 p/font 都合法
    span.textContent = text;
    return span;
  }

  // ---- 進畫面 → 排隊 → 批次翻譯 ----
  function pairFromTarget(target) {
    const pair = target?.closest?.('.' + PAIR_CLASS);
    if (!pair) return null;
    return pairUnits.get(pair.getAttribute('data-gt-pair')) || null;
  }

  function showPairHighlight(unit) {
    if (!unit || highlightedUnit === unit) return;
    clearPairHighlight();
    highlightedUnit = unit;
    unit.translationNode?.classList?.add(ACTIVE_PAIR_CLASS);
    if (globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function' && unit.sourceRanges.length) {
      CSS.highlights.set(SOURCE_HIGHLIGHT, new Highlight(...unit.sourceRanges));
    } else {
      unit.el?.classList?.add('gt-source-pair-fallback');
    }
  }

  function clearPairHighlight() {
    highlightedUnit?.translationNode?.classList?.remove(ACTIVE_PAIR_CLASS);
    highlightedUnit?.el?.classList?.remove('gt-source-pair-fallback');
    globalThis.CSS?.highlights?.delete(SOURCE_HIGHLIGHT);
    highlightedUnit = null;
  }

  function onPairPointerOver(event) {
    if (!active || lockedUnit) return;
    const unit = pairFromTarget(event.target);
    if (unit) showPairHighlight(unit);
  }

  function onPairPointerOut(event) {
    if (!active || lockedUnit || !pairFromTarget(event.target)) return;
    if (!pairFromTarget(event.relatedTarget)) clearPairHighlight();
  }

  function onPairClick(event) {
    if (!active) return;
    const unit = pairFromTarget(event.target);
    if (unit) {
      lockedUnit = lockedUnit === unit ? null : unit;
      if (lockedUnit) showPairHighlight(lockedUnit);
      else clearPairHighlight();
      return;
    }
    lockedUnit = null;
    clearPairHighlight();
  }

  function onPairKeyDown(event) {
    if (event.key !== 'Escape') return;
    lockedUnit = null;
    clearPairHighlight();
  }

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
    const currentRun = runId;
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
      if (!active || currentRun !== runId) return;
      await translateBatch(batch, currentRun);
    }
    if (active && currentRun === runId && pending.size > 0) scheduleFlush();
  }

  async function translateBatch(batch, currentRun) {
    const texts = batch.map((u) => u.text);
    let res;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'TRANSLATE', texts, target: settings.targetLang, model: settings.model
      });
    } catch (e) {
      res = { ok: false, error: String(e) };
    }

    // 使用者可能在請求期間還原或重新啟動；舊工作不得再改動頁面。
    if (!active || currentRun !== runId) return;

    if (!res || !res.ok) {
      const retryUnits = res?.retryable === false
        ? []
        : batch.filter((u) => u.retryCount < MAX_BATCH_RETRIES);
      batch.forEach((u) => { u.queued = false; });

      if (retryUnits.length > 0) {
        retryUnits.forEach((u) => { u.retryCount += 1; });
        toast('翻譯暫時失敗，將自動重試一次：' + (res ? res.error : '未知錯誤'));
        setTimeout(() => {
          if (!active || currentRun !== runId) return;
          retryUnits.forEach((u) => {
            if (u.done || u.queued) return;
            u.queued = true;
            pending.add(u);
          });
          scheduleFlush();
        }, RETRY_DELAY);
      } else {
        toast('翻譯失敗：' + (res ? res.error : '未知錯誤'));
      }
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
