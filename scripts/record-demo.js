const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = path.join(ROOT, '.demo-chrome-profile');
const OUTPUT_DIR = path.join(ROOT, 'assets');
const PORT = 9333;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const FFMPEG = process.env.GWT_FFMPEG || 'ffmpeg';
const FRAME_RATE = 15;

const translations = [
  '如何成就卓越工作',
  '2023 年 7 月',
  '如果你彙整許多不同領域中，成就卓越工作的各種方法，它們的交集會是什麼模樣？',
  '我決定親自找出答案，於是整理出這篇文章。',
  '我的目標之一，是寫出一份任何領域的工作者都能使用的指南。',
  '但我也很好奇，這些方法的交集究竟呈現什麼形狀。',
  '這次整理顯示，它確實有明確的形狀，而不只是一個寫著「努力工作」的點。',
  '以下方法假設你懷抱很大的企圖心。',
  '第一步，是決定自己要投入什麼。',
  '卓越工作往往始於⟦L0⟧好奇心⟦/L0⟧：追隨那些讓你無法停止思考的問題。',
  '選擇你有天分、抱有深刻興趣，而且有空間做出卓越成果的工作。',
  '從小型專案開始，讓每一次嘗試都為下一步帶來線索。'
];

const demoHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>How to Do Great Work</title>
<style>html{background:#f3f5f8}body{max-width:760px;margin:0 auto;padding:72px 72px 120px;background:#fff;color:#182033;font:19px/1.72 Georgia,serif;box-shadow:0 0 60px rgba(28,39,58,.1)}h1{margin:0 0 6px;color:#0c1830;font:700 46px/1.15 Georgia,serif;letter-spacing:-.025em}.date{margin:0 0 38px;color:#768197;font:14px/1.4 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.11em}p{margin:0 0 23px}a{color:#245fa9;text-decoration-thickness:1px;text-underline-offset:3px}</style>
</head><body><h1>How to Do Great Work</h1><p class="date">July 2023</p>
<p>If you collected lists of techniques for doing great work in many different fields, what would the intersection look like? I decided to find out by making it.</p>
<p>Partly my goal was to create a guide that could be used by someone working in any field. But I was also curious about the shape of the intersection.</p>
<p>This exercise shows that it has a definite shape; it is not just a point labelled “work hard.” The following recipe assumes you are very ambitious.</p>
<p>The first step is to decide what to work on. Great work often begins with <a href="https://paulgraham.com/greatwork.html" target="_blank">curiosity</a>: follow the questions you cannot stop thinking about.</p>
<p>Choose work you have a natural aptitude for, a deep interest in, and enough scope to do something great. Start with small projects, and let each attempt give you clues for the next.</p>
</body></html>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const target = targets.find((item) => item.type === 'page' && item.url.includes('demo.html'));
      if (target) return target;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome DevTools target was not available');
}

async function main() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const demoPath = path.join(PROFILE, 'demo.html');
  fs.writeFileSync(demoPath, demoHtml);
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1280,720',
    '--force-device-scale-factor=1',
    '--hide-scrollbars',
    pathToFileURL(demoPath).href
  ], { stdio: 'ignore', windowsHide: true });

  try {
    const target = await connect();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

    await call('Runtime.enable');
    await call('Page.enable');
    await call('Runtime.evaluate', {
      expression: `new Promise((resolve) => document.readyState === 'complete' ? resolve() : addEventListener('load', resolve, { once: true }))`,
      awaitPromise: true
    });

    const contentSource = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
    const contentCss = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');
    await call('Runtime.evaluate', {
      expression: `(() => {
        const style = document.createElement('style');
        style.textContent = ${JSON.stringify(contentCss + `
          body { padding-top: 54px !important; }
          .demo-bar { position: fixed; z-index: 2147483646; inset: 0 0 auto; height: 54px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; padding: 0 26px; background: rgba(9, 20, 43, .96); color: white; font: 600 15px/1 system-ui, sans-serif; box-shadow: 0 2px 14px rgba(0,0,0,.24); }
          .demo-brand { display: flex; align-items: center; gap: 11px; }
          .demo-lines { width: 28px; display: grid; gap: 4px; }
          .demo-lines i { height: 2px; border-radius: 2px; background: #8ab4f8; }
          .demo-status { color: #a8c7fa; font-size: 13px; }
          .demo-caption { position: fixed; z-index: 2147483647; left: 50%; bottom: 34px; transform: translateX(-50%) translateY(14px); padding: 12px 20px; border-radius: 999px; background: rgba(9,20,43,.94); color: #fff; font: 600 16px/1.25 system-ui,sans-serif; box-shadow: 0 8px 30px rgba(0,0,0,.28); opacity: 0; transition: .35s ease; pointer-events: none; }
          .demo-caption.show { opacity: 1; transform: translateX(-50%) translateY(0); }
          .demo-cursor { position: fixed; z-index: 2147483647; left: 1060px; top: 600px; width: 18px; height: 24px; filter: drop-shadow(0 2px 2px rgba(0,0,0,.35)); transition: left .65s cubic-bezier(.2,.8,.2,1), top .65s cubic-bezier(.2,.8,.2,1); pointer-events: none; }
          .demo-cursor::before { content: ''; display: block; width: 0; height: 0; border-left: 8px solid white; border-right: 8px solid transparent; border-bottom: 21px solid transparent; transform: rotate(-12deg); filter: drop-shadow(0 0 1px #111); }
        `)};
        document.head.appendChild(style);
        const bar = document.createElement('div');
        bar.className = 'demo-bar';
        bar.innerHTML = '<span class="demo-brand"><span class="demo-lines"><i></i><i></i><i></i><i></i></span>Gemini Web Translator</span><span class="demo-status">Ready · Alt+T</span>';
        document.body.appendChild(bar);
        const caption = document.createElement('div');
        caption.className = 'demo-caption';
        document.body.appendChild(caption);
        const cursor = document.createElement('div');
        cursor.className = 'demo-cursor';
        document.body.appendChild(cursor);
        window.__demo = { bar, caption, cursor, translationIndex: 0 };
        Object.defineProperty(window, 'chrome', {
          configurable: true,
          value: {
            runtime: {
              onMessage: { addListener(listener) { window.__demo.listener = listener; } },
              sendMessage(message) {
                if (message.type === 'TRANSLATE') {
                  return new Promise((resolve) => setTimeout(() => resolve({
                    ok: true,
                    translations: message.texts.map((text) => ${JSON.stringify(translations)}[window.__demo.translationIndex++] || '延伸閱讀：' + text)
                  }), 650));
                }
                return Promise.resolve();
              }
            },
            storage: { local: { get: async () => ({ apiKey: 'demo', model: 'gemini-flash-lite-latest', targetLang: '繁體中文' }) } }
          }
        });
      })()`
    });
    await call('Runtime.evaluate', {
      expression: `(() => { window.__gtLoaded = false; delete window.__gtListener; })()`
    });
    const injection = await call('Runtime.evaluate', { expression: contentSource });
    if (injection.exceptionDetails) {
      throw new Error(`Content script injection failed: ${injection.exceptionDetails.exception?.description || injection.exceptionDetails.text}`);
    }
    const runtimeState = await call('Runtime.evaluate', {
      expression: `({ loaded: window.__gtLoaded, listener: typeof window.__demo?.listener, chromeRuntime: typeof window.chrome?.runtime, addListener: typeof window.chrome?.runtime?.onMessage?.addListener })`,
      returnByValue: true
    });
    if (runtimeState.result.value.listener !== 'function') {
      throw new Error(`Content listener unavailable: ${JSON.stringify(runtimeState.result.value)}`);
    }

    const outputPath = path.join(OUTPUT_DIR, 'gemini-web-translator-demo.mp4');
    const framesPath = path.join(PROFILE, 'frames');
    fs.mkdirSync(framesPath, { recursive: true });
    let frameIndex = 0;
    let capturing = true;
    const captureLoop = (async () => {
      while (capturing) {
        const startedAt = Date.now();
        const frame = await call('Page.captureScreenshot', {
          format: 'jpeg', quality: 88, captureBeyondViewport: false, fromSurface: true
        });
        const frameName = `frame-${String(frameIndex++).padStart(5, '0')}.jpg`;
        fs.writeFileSync(path.join(framesPath, frameName), Buffer.from(frame.data, 'base64'));
        const remaining = Math.round(1000 / FRAME_RATE) - (Date.now() - startedAt);
        if (remaining > 0) await sleep(remaining);
      }
    })();

    const evaluate = (expression) => call('Runtime.evaluate', { expression, awaitPromise: true });
    const caption = async (text, duration = 1800) => {
      await evaluate(`(() => { const el = window.__demo.caption; el.textContent = ${JSON.stringify(text)}; el.classList.add('show'); })()`);
      await sleep(duration);
      await evaluate(`window.__demo.caption.classList.remove('show')`);
      await sleep(350);
    };
    const moveCursor = async (x, y) => {
      await evaluate(`(() => { window.__demo.cursor.style.left = '${x}px'; window.__demo.cursor.style.top = '${y}px'; })()`);
      await sleep(750);
    };

    await sleep(1000);
    await caption('Keep the original. Add Taiwan Traditional Chinese.', 1900);
    await moveCursor(1160, 28);
    await evaluate(`window.__demo.bar.querySelector('.demo-status').textContent = 'Translating…'`);
    const toggleResult = await call('Runtime.evaluate', {
      expression: `new Promise((resolve) => window.__demo.listener({ type: 'TOGGLE' }, {}, resolve))`,
      awaitPromise: true,
      returnByValue: true
    });
    if (toggleResult.exceptionDetails) {
      throw new Error(`Translation toggle failed: ${toggleResult.exceptionDetails.exception?.description || toggleResult.exceptionDetails.text}`);
    }
    await sleep(1700);
    await evaluate(`window.__demo.bar.querySelector('.demo-status').textContent = 'Translated · cached locally'`);
    await caption('Translate in large batches. Cache completed results.', 1900);

    await evaluate(`window.scrollTo({ top: 260, behavior: 'smooth' })`);
    await sleep(1400);
    const pairReady = await call('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
        const deadline = Date.now() + 7000;
        const check = () => {
          if (document.querySelector('.gt-pair')) return resolve(true);
          if (Date.now() >= deadline) return resolve(false);
          setTimeout(check, 100);
        };
        check();
      })`,
      awaitPromise: true,
      returnByValue: true
    });
    if (!pairReady.result.value) {
      const diagnostic = await call('Runtime.evaluate', {
        expression: `({ url: location.href, anchors: document.querySelectorAll('.gt-observe-anchor').length, translations: document.querySelectorAll('.gt-translation').length })`,
        returnByValue: true
      });
      throw new Error(`Translations did not appear: ${JSON.stringify(diagnostic.result.value)}`);
    }
    const pairPosition = await call('Runtime.evaluate', {
      expression: `(() => { const pair = document.querySelectorAll('.gt-pair')[2]; const r = pair.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 260), y: r.top + r.height / 2 }; })()`,
      returnByValue: true
    });
    await moveCursor(pairPosition.result.value.x, pairPosition.result.value.y);
    await evaluate(`document.querySelectorAll('.gt-pair')[2].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))`);
    await caption('Hover a sentence to find its source.', 2100);
    await evaluate(`document.querySelectorAll('.gt-pair')[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await caption('Click to pin the pair. Press Esc to clear.', 1800);

    await evaluate(`window.scrollTo({ top: 900, behavior: 'smooth' })`);
    await sleep(1400);
    await caption('Links stay clickable. Long pages stay within quota.', 2200);
    await evaluate(`window.scrollTo({ top: 0, behavior: 'smooth' })`);
    await sleep(1300);
    await caption('Read the web in your language.', 1800);
    await sleep(500);

    capturing = false;
    await captureLoop;
    const encoder = spawn(FFMPEG, [
      '-y', '-loglevel', 'error',
      '-framerate', String(FRAME_RATE), '-i', path.join(framesPath, 'frame-%05d.jpg'),
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
      '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', outputPath
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let encoderError = '';
    encoder.stderr.on('data', (chunk) => { encoderError += chunk; });
    const encoderExit = await new Promise((resolve) => encoder.once('exit', resolve));
    if (encoderExit !== 0) throw new Error(`FFmpeg failed: ${encoderError.trim()}`);

    const poster = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'gemini-web-translator-demo.png'), Buffer.from(poster.data, 'base64'));
    socket.close();
    process.stdout.write(JSON.stringify({ videoBytes: fs.statSync(outputPath).size }, null, 2));
  } finally {
    chrome.kill();
    await sleep(800);
    fs.rmSync(PROFILE, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
