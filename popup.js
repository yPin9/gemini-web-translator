// popup.js
async function getTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function send(tab, type) {
  return chrome.tabs.sendMessage(tab.id, { type }).catch(() => {
    // content script 尚未載入（例如 chrome:// 或剛開的分頁）
    alert('這個頁面無法翻譯（可能是瀏覽器內建頁或需要重新整理）。');
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) document.getElementById('warn').style.display = 'block';

  const tab = await getTab();

  document.getElementById('toggle').addEventListener('click', async () => {
    await send(tab, 'TOGGLE');
    window.close();
  });

  document.getElementById('restore').addEventListener('click', async () => {
    // 只在已翻譯時才會移除；未翻譯則 TOGGLE 會開始翻譯，所以這裡用專用還原
    await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' }).then((r) => {
      if (r && r.state) send(tab, 'TOGGLE');
    }).catch(() => {});
    window.close();
  });

  const openOpts = () => chrome.runtime.openOptionsPage();
  document.getElementById('openOptions').addEventListener('click', openOpts);
  document.getElementById('warnLink').addEventListener('click', openOpts);
});
