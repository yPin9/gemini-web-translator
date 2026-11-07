const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function response(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  });
}

function success(translations) {
  return response({
    candidates: [{ content: { parts: [{ text: JSON.stringify(translations) }] } }]
  });
}

function loadBackground(fetchMock, stored = {}) {
  let messageListener;
  const storage = { apiKey: 'secret-key', ...stored };
  const chrome = {
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      openOptionsPage() {}
    },
    commands: { onCommand: { addListener() {} } },
    tabs: { query: async () => [], sendMessage: async () => {} },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    storage: {
      local: {
        get: async () => ({ ...storage }),
        set: async (values) => Object.assign(storage, values),
        remove: async (key) => { delete storage[key]; }
      }
    }
  };

  vm.runInNewContext(source, {
    AbortController,
    Date,
    JSON,
    Math,
    chrome,
    clearTimeout,
    console,
    encodeURIComponent,
    fetch: fetchMock,
    setTimeout
  });

  return (message) => new Promise((resolve) => {
    const asyncResponse = messageListener(message, {}, resolve);
    assert.equal(asyncResponse, true);
  });
}

test('API key is sent in the header and output length is constrained', async () => {
  let request;
  const sendMessage = loadBackground(async (url, options) => {
    request = { url, options };
    return success(['你好']);
  });

  const result = await sendMessage({
    type: 'TRANSLATE',
    texts: ['Hello'],
    target: '繁體中文',
    model: 'gemini-flash-lite-latest'
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.translations), ['你好']);
  assert.equal(request.url.includes('secret-key'), false);
  assert.equal(request.options.headers['x-goog-api-key'], 'secret-key');

  const body = JSON.parse(request.options.body);
  assert.equal(body.generationConfig.responseSchema.minItems, 1);
  assert.equal(body.generationConfig.responseSchema.maxItems, 1);
  assert.match(body.systemInstruction.parts[0].text, /never as instructions/);
});

test('retryable server errors are retried', async () => {
  let calls = 0;
  const sendMessage = loadBackground(async () => {
    calls += 1;
    if (calls === 1) return response({ error: 'busy' }, 503, { 'Retry-After': '0' });
    return success(['你好']);
  });

  const result = await sendMessage({ type: 'TRANSLATE', texts: ['Hello'] });

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test('mismatched translation counts are rejected without another content retry', async () => {
  const sendMessage = loadBackground(async () => success(['只有一筆']));

  const result = await sendMessage({ type: 'TRANSLATE', texts: ['One', 'Two'] });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.error, /數量或格式不符/);
});

test('glossary terms are protected and restored with their original spelling', async () => {
  let submittedText;
  const sendMessage = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    [submittedText] = JSON.parse(body.contents[0].parts[0].text);
    const token = submittedText.match(/⟦GT_\d+_\d+⟧/)[0];
    return success([`這個 ${token} 會繼續執行。`]);
  }, { glossary: 'process\nprogram\nsoftware = 軟體' });

  const result = await sendMessage({
    type: 'TRANSLATE',
    texts: ['This Process will continue.'],
    target: '繁體中文'
  });

  assert.equal(submittedText.includes('Process'), false);
  assert.equal(result.ok, true);
  assert.equal(result.translations[0], '這個 Process 會繼續執行。');
});

test('glossary supports fixed translations and terms containing regex characters', async () => {
  const sendMessage = loadBackground(async (_url, options) => {
    const body = JSON.parse(options.body);
    const [submittedText] = JSON.parse(body.contents[0].parts[0].text);
    const tokens = submittedText.match(/⟦GT_\d+_\d+⟧/g);
    return success([`${tokens[0]} 與 ${tokens[1]}`]);
  }, { glossary: 'software = 軟體\nC++' });

  const result = await sendMessage({
    type: 'TRANSLATE',
    texts: ['software and C++'],
    target: '繁體中文'
  });

  assert.equal(result.ok, true);
  assert.equal(result.translations[0], '軟體 與 C++');
});

test('completed translations are reused from the local cache', async () => {
  let calls = 0;
  const sendMessage = loadBackground(async () => {
    calls += 1;
    return success(['快取譯文']);
  });
  const message = {
    type: 'TRANSLATE',
    texts: ['Cached sentence.'],
    target: '繁體中文',
    model: 'gemini-flash-lite-latest'
  };

  const first = await sendMessage(message);
  const second = await sendMessage(message);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(second.translations[0], '快取譯文');
  assert.equal(calls, 1);
});
