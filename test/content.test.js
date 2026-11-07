const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a translation response arriving after restore cannot modify the page', async () => {
  let messageListener;
  let intersectionObserver;
  let resolveTranslation;
  const inserted = [];

  const element = {
    appendChild(node) { inserted.push(node); },
    closest() { return null; },
    getClientRects() { return [{}]; },
    getElementsByTagName() { return []; },
    innerText: 'Hello world',
    querySelectorAll() { return []; },
    textContent: 'Hello world'
  };

  const document = {
    createElement() { return { className: '', style: {}, textContent: '' }; },
    documentElement: { appendChild() {} },
    querySelectorAll(selector) { return selector.startsWith('.') ? [] : [element]; }
  };

  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      intersectionObserver = this;
    }
    disconnect() {}
    observe() {}
    unobserve() {}
  }

  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage(message) {
        if (message.type === 'TRANSLATE') {
          return new Promise((resolve) => { resolveTranslation = resolve; });
        }
        return Promise.resolve();
      }
    },
    storage: {
      local: {
        get: async () => ({
          apiKey: 'secret-key',
          model: 'gemini-flash-lite-latest',
          targetLang: '繁體中文'
        })
      }
    }
  };

  vm.runInNewContext(source, {
    IntersectionObserver: FakeIntersectionObserver,
    Node: { TEXT_NODE: 3 },
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4 },
    chrome,
    clearTimeout,
    console,
    document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    setTimeout,
    window: {}
  });

  const sendToContent = (type) => new Promise((resolve) => {
    const asyncResponse = messageListener({ type }, {}, resolve);
    if (asyncResponse !== true) resolve();
  });

  assert.equal((await sendToContent('TOGGLE')).state, 'on');
  intersectionObserver.callback([{ isIntersecting: true, target: element }]);
  await wait(400);
  assert.equal(typeof resolveTranslation, 'function');

  assert.equal((await sendToContent('TOGGLE')).state, 'off');
  resolveTranslation({ ok: true, translations: ['你好世界'] });
  await wait(0);

  assert.equal(inserted.length, 0);
});
