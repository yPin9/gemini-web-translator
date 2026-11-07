// options.js
const $ = (id) => document.getElementById(id);

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = cls || '';
}

document.addEventListener('DOMContentLoaded', async () => {
  const s = await chrome.storage.local.get(['apiKey', 'model', 'targetLang', 'glossary']);
  if (s.apiKey) $('apiKey').value = s.apiKey;
  if (s.model) $('model').value = s.model;
  if (s.targetLang) $('targetLang').value = s.targetLang;
  if (s.glossary) $('glossary').value = s.glossary;

  $('save').addEventListener('click', async () => {
    await chrome.storage.local.set({
      apiKey: $('apiKey').value.trim(),
      model: $('model').value,
      targetLang: $('targetLang').value.trim() || '繁體中文',
      glossary: $('glossary').value
    });
    setStatus('已儲存 ✓', 'ok');
  });

  $('test').addEventListener('click', async () => {
    const apiKey = $('apiKey').value.trim();
    if (!apiKey) return setStatus('請先填入 API key', 'err');
    setStatus('測試中…', '');
    // 先存起來讓 background 讀得到
    await chrome.storage.local.set({ apiKey, model: $('model').value });
    const res = await chrome.runtime.sendMessage({
      type: 'TRANSLATE',
      texts: ['Hello, world.'],
      target: $('targetLang').value.trim() || '繁體中文',
      model: $('model').value
    });
    if (res && res.ok) {
      setStatus('連線成功 ✓ 範例：' + res.translations[0], 'ok');
    } else {
      setStatus('失敗：' + (res ? res.error : '未知錯誤'), 'err');
    }
  });

  $('clearCache').addEventListener('click', async () => {
    await chrome.storage.local.remove('translationCache');
    setStatus('翻譯快取已清除', 'ok');
  });
});
