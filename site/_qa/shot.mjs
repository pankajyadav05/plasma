import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const PORT = 9222 + Math.floor(Math.random() * 700);
const ud = mkdtempSync(join(tmpdir(), 'cqa-'));

const child = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${ud}`,
  '--window-size=1440,900',
  '--hide-scrollbars',
  'about:blank',
], { stdio: 'ignore' });

await new Promise((r) => setTimeout(r, 1800));

async function getDebuggerUrl() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json());
      if (list[0]?.webSocketDebuggerUrl) return list[0].webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no debugger url');
}

const wsUrl = await getDebuggerUrl();
const ws = new WebSocket(wsUrl);
await new Promise((r, rej) => {
  ws.onopen = r;
  ws.onerror = rej;
});

let id = 1;
const calls = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && calls.has(m.id)) {
    const r = calls.get(m.id);
    calls.delete(m.id);
    r(m.result);
  }
};
function call(method, params = {}) {
  const myId = id++;
  return new Promise((resolve) => {
    calls.set(myId, resolve);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
}

await call('Page.enable');
await call('Runtime.enable');
await call('Page.navigate', { url: 'http://localhost:3000/' });
await new Promise((r) => setTimeout(r, 5000));

const sections = ['#top', '#showcase', '#atlas', '#versus', '#open'];
const names = ['hero', 'showcase', 'atlas', 'versus', 'open'];
for (let i = 0; i < sections.length; i++) {
  await call('Runtime.evaluate', {
    expression: `(function(){const el=document.querySelector('${sections[i]}');if(el){el.scrollIntoView({block:'start',behavior:'instant'});}})();`,
    awaitPromise: false,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const res = await call('Page.captureScreenshot', { format: 'png' });
  if (res?.data) {
    writeFileSync(`shot-${names[i]}.png`, Buffer.from(res.data, 'base64'));
    console.log(`saved shot-${names[i]}.png`);
  } else {
    console.log(`failed ${names[i]}`);
  }
}
ws.close();
child.kill('SIGKILL');
process.exit(0);
