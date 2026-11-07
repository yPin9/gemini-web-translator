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

test('legacy br layouts translate only visible paragraphs and keep single breaks together', async () => {
  let messageListener;
  let intersectionObserver;
  let sourceHighlight;
  const observed = [];
  const requests = [];
  const inserted = [];
  const listeners = {};

  const makeElement = () => {
    const attributes = {};
    const classes = new Set();
    return {
      children: [],
      className: '',
      classList: {
        add(value) { classes.add(value); },
        remove(value) { classes.delete(value); }
      },
      closest(selector) {
        return selector === '.gt-pair' && this.className === 'gt-pair' ? this : null;
      },
      getAttribute(name) { return attributes[name]; },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(name, value) { attributes[name] = value; },
      style: {},
      textContent: ''
    };
  };

  const parent = {
    insertBefore(node, anchor) { inserted.push({ node, anchor }); }
  };
  const textNode = (value) => ({ nodeType: 3, nodeValue: value, parentNode: parent });
  const br = () => ({ nodeType: 1, nodeName: 'BR', parentNode: parent });
  const nodes = [
    textNode('First sentence.'), br(), textNode('Second sentence!'), br(), br(),
    textNode('Second paragraph'), br(), br(), textNode('Third paragraph')
  ];
  const breaks = nodes.filter((node) => node.nodeName === 'BR');

  const element = {
    appendChild(node) { inserted.push({ node, anchor: null }); },
    closest() { return null; },
    firstChild: nodes[0],
    getClientRects() { return [{}]; },
    getElementsByTagName(name) { return name === 'br' ? breaks : []; },
    innerText: 'First sentence. Second sentence! Second paragraph Third paragraph',
    insertBefore(node, anchor) { inserted.push({ node, anchor }); },
    querySelectorAll() { return []; },
    textContent: 'First sentence. Second sentence! Second paragraph Third paragraph'
  };

  const document = {
    addEventListener(type, listener) { listeners[type] = listener; },
    createElement: makeElement,
    createRange() {
      return {
        setEnd(node, offset) { this.end = { node, offset }; },
        setStart(node, offset) { this.start = { node, offset }; }
      };
    },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
    createTreeWalker() {
      let index = 0;
      return { nextNode: () => nodes[index++] || null };
    },
    documentElement: { appendChild() {} },
    querySelectorAll(selector) { return selector.startsWith('.') ? [] : [element]; }
  };

  class FakeIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      intersectionObserver = this;
    }
    disconnect() {}
    observe(target) {
      observed.push(target);
    }
    unobserve() {}
  }

  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      sendMessage(message) {
        if (message.type === 'TRANSLATE') {
          requests.push(message.texts);
          return Promise.resolve({
            ok: true,
            translations: message.texts.map((text) => '譯：' + text)
          });
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
    window: {},
    CSS: {
      highlights: {
        delete() { sourceHighlight = null; },
        set(name, highlight) { sourceHighlight = { highlight, name }; }
      }
    },
    Highlight: class {
      constructor(...ranges) { this.ranges = ranges; }
    }
  });

  const sendToContent = (type) => new Promise((resolve) => {
    const asyncResponse = messageListener({ type }, {}, resolve);
    if (asyncResponse !== true) resolve();
  });

  assert.equal((await sendToContent('TOGGLE')).state, 'on');
  assert.equal(observed.length, 3);
  assert.notEqual(observed[0], element);

  intersectionObserver.callback([{ isIntersecting: true, target: observed[0] }]);
  await wait(400);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].length, 2);
  assert.equal(requests[0][0], 'First sentence.');
  assert.equal(requests[0][1], 'Second sentence!');

  const translation = inserted.find(({ node }) => node.className === 'gt-translation').node;
  const firstPair = translation.children.find((node) => node.className === 'gt-pair');
  listeners.pointerover({ target: firstPair });

  assert.equal(sourceHighlight.name, 'gt-source-pair');
  assert.equal(sourceHighlight.highlight.ranges.length, 1);
  assert.equal(sourceHighlight.highlight.ranges[0].start.offset, 0);
  assert.equal(sourceHighlight.highlight.ranges[0].end.offset, 'First sentence.'.length);
});
