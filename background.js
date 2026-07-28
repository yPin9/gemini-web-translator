// background.js — service worker：呼叫 Gemini API、處理快捷鍵、更新 badge

const DEFAULTS = { model: 'gemini-flash-lite-latest', targetLang: '繁體中文' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'TRANSLATE') {
    handleTranslate(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 非同步回應
  }

  if (msg.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return;
  }

  if (msg.type === 'BADGE') {
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      chrome.action.setBadgeText({ tabId, text: msg.text || '' });
      chrome.action.setBadgeBackgroundColor({ tabId, color: msg.color || '#4285f4' });
    }
    return;
  }
});

// 快捷鍵：轉發給目前分頁的 content script
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE' }).catch(() => {});
  }
});

async function fetchWithRetry(url, opts, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await fetch(url, opts);
    if (last.status === 429 || last.status === 503) {
      await sleep(1500 * (i + 1)); // 遇到速率限制 / 忙碌時退避重試
      continue;
    }
    return last;
  }
  return last;
}

async function handleTranslate({ texts, target, model }) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) return { ok: false, error: 'NO_KEY' };

  const m = model || DEFAULTS.model;
  const lang = target || DEFAULTS.targetLang;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=` +
    encodeURIComponent(apiKey);

  const prompt =
    `You are a professional translator. Translate every string in the input JSON array into ${lang}.\n` +
    `Rules:\n` +
    `- Return ONLY a JSON array of translated strings.\n` +
    `- Keep exactly the same number of elements and the same order.\n` +
    `- Preserve meaning, tone, proper nouns, numbers and inline symbols.\n` +
    `- If a string should not be translated (e.g. code, URLs), return it unchanged.\n` +
    `Input:\n${JSON.stringify(texts)}`;

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: { type: 'ARRAY', items: { type: 'STRING' } }
    }
  };

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    return { ok: false, error: `HTTP ${resp.status}: ${t.slice(0, 300)}` };
  }

  const data = await resp.json();
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!txt) {
    const reason = data?.promptFeedback?.blockReason;
    return { ok: false, error: reason ? `被安全機制阻擋 (${reason})` : '空的回應' };
  }

  let arr;
  try {
    arr = JSON.parse(txt);
  } catch {
    return { ok: false, error: 'JSON 解析失敗' };
  }
  if (!Array.isArray(arr)) return { ok: false, error: '回應不是陣列' };

  return { ok: true, translations: arr };
}
