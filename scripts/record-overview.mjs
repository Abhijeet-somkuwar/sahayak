#!/usr/bin/env node
/**
 * Records the Sahayak product-overview video.
 *
 * One 1920x1080 "stage" page embeds the real screens as frames: the patient's phone, the gate kiosk, the
 * waiting-hall TV, the registration counter, the doctor's console and the casualty board. The demo story from
 * docs/DEMO_GUIDE.md is then played across them with captions, a visible cursor and (on Windows) a spoken
 * narration generated with the built-in text-to-speech voice.
 *
 *   node scripts/record-overview.mjs [--out docs/video] [--work <tmp dir>] [--fast] [--no-voice] [--voice "Microsoft Zira Desktop"]
 *
 * Needs the development backend (npm run dev:backend) and the frontend (npm run dev:frontend) running on this machine,
 * and ffmpeg on PATH for the .mp4 files (without it the raw .webm is kept). --fast skips the pauses and narration
 * (a quick check that every step still works).
 *
 * Outputs (in --out): sahayak-overview.mp4 (narrated), sahayak-overview-silent.mp4, captions.json (caption times).
 */
import { chromium } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const FAST = args.includes('--fast');
const VOICE = !FAST && !args.includes('--no-voice') && process.platform === 'win32';
const VOICE_NAME = opt('--voice', 'Microsoft Zira Desktop');
const OUT = path.resolve(opt('--out', 'docs/video'));
const WORK = path.resolve(opt('--work', path.join(os.tmpdir(), 'sahayak-overview')));
const API = process.env.E2E_API_URL || 'http://localhost:8000/api/v1';
const A = 'http://localhost:5173'; // patient, kiosk, TV, counter, casualty
const B = 'http://127.0.0.1:5173'; // the doctor: a second origin, so his staff session never mixes with the clerk's
const FACILITY = process.env.E2E_FACILITY_CODE || 'GJ-DEMO-DH';
const W = 1920;
const H = 1080;

/* ------------------------------------------------------------------------------------------------ narration */
// Every caption is also the narration. Keep them short, plain and true to what is on screen.
const N = {
  intro: 'This is Sahayak, the front door of a government hospital’s OPD. In the next few minutes we follow one patient, Sunita, from her home to the doctor’s room, and see what every person in the hospital sees.',
  empty: 'On the left is the patient’s phone. On the right, the doctor’s screen. The queue is empty: nothing has happened yet today.',
  p1_start: 'Sunita Sharma, 58, has had fever and body ache for two days. Her son opens the hospital page on his phone and taps Start a visit.',
  p1_otp: 'He signs in with his mobile number. A one-time code arrives by SMS. In this demo, the code is shown on the screen.',
  p1_consent: 'Consent comes first. She agrees to the visit, and allows a computer assistant to help with the questions.',
  p1_who: 'Who is the patient? Her name, sex and age, and how she is related to the phone’s owner.',
  p1_describe: 'Now she describes the problem in her own words. Hindi, Gujarati and Hinglish work just as well.',
  p1_understood: 'The assistant shows what it understood: fever and body ache, since two days. Then it asks a few safety questions, written by doctors, not by the AI.',
  p1_answers: 'No danger signs. A couple of routine questions follow: how long, any long-term illness, any disability.',
  p1_booked: 'Her visit is booked: Medicine OPD, Room 1, a time window to arrive, the expected wait, and a QR code for the gate.',
  p1_decided: 'Further down: How Sahayak decided. What she told us, how urgent it is and why, and which department. The AI suggested the department; the hospital’s own clinical rules decided she is routine. This is not a diagnosis. The patient never sees an AI-guessed disease.',
  p1_doctor_nothing: 'Notice the doctor’s screen: still nothing. Token numbers are given only on arrival, so nobody can hold a place in the queue from home.',
  p2_kiosk: 'Sunita reaches the hospital. At the gate kiosk she scans her QR code. Here, we type the check-in code instead.',
  p2_checked: 'Checked in. She gets her token number, the room to go to, how many people are ahead of her, and a short slip code.',
  p2_status: 'On her phone, she enters the slip code and follows the queue live.',
  p2_doctor: 'The doctor’s queue now shows her token in the General lane. In the background, Sahayak starts preparing her case summary.',
  p3_counter: 'Not everyone has a smartphone. Ramesh Patel, 72, walks up to the registration counter.',
  p3_register: 'The clerk registers him in seconds: name, sex, age, mobile number and district. The clerk never sees any medical details.',
  p3_checkin: 'One click checks him into Medicine OPD. He gets the next token and a status link for his phone.',
  p3_lane: 'Ramesh is over sixty, so he joins the Protected lane.',
  p4_lanes: 'Doctor Anil Mehta’s screen has three lanes: Urgent, Protected and General. Ramesh is in Protected, Sunita in General. He clicks Call next.',
  p4_ramesh: 'Ramesh is called first, even though Sunita checked in earlier. Protected and general patients take turns: one protected for every two general.',
  p4_tv: 'The waiting-hall TV announces his token and room with a chime, and rotates between English, Hindi and Gujarati.',
  p4_consult: 'Start consult, then Complete. Then Call next again. This time it is Sunita.',
  p4_phone: 'Her phone turns green: Your turn, go to Room 1 now.',
  p4_card: 'The doctor’s card. At the top, facts from her record: allergies, medicines, conditions, today’s complaint. Below, a Summary marked AI-generated, verify, written before she walked in: a headline, key points, possible conditions to consider, and questions worth asking.',
  p4_guidelines: 'Those possible conditions are suggestions for the doctor only. India’s Telemedicine Practice Guidelines let AI assist the doctor, never diagnose the patient.',
  p4_diagnosis: 'The doctor records the diagnosis: viral fever.',
  p4_rx: 'And a prescription: Paracetamol 500 milligrams, one tablet, three times a day, for three days, after food.',
  p4_done: 'Complete. Sunita’s phone shows Visit complete, with her diagnosis and her medicines in plain words. She shows this screen at the pharmacy.',
  p5_back: 'A week later, Sunita is back with a headache. She signs in with the same number, and Sahayak already knows her. No name, age or consent questions this time.',
  p5_booked: 'She describes the new problem, answers the safety questions, and is booked again.',
  p5_kiosk: 'At the gate, she checks in.',
  p5_doctor: 'The doctor calls her, and now the screen shows her past: the fever visit under Recent visits, paracetamol under Medicines, an AI History summary, and possible conditions for today’s headache.',
  p5_history: 'At the bottom, the full visit history for the last 24 months. Opening a visit shows its diagnosis, medicines, the doctor who saw her, and the AI summary written at that visit.',
  p5_phone: 'And on her phone: My visits and medicines. Every visit and every prescription in one place.',
  p6_start: 'One last scenario. From the same phone, Sunita’s husband Mahesh, 61, reports chest pain and sweating since one hour.',
  p6_red: 'A red screen: Go to Casualty now, call 108. No booking, no more questions. Danger words are caught by a list written by doctors, before any AI is asked.',
  p6_ed: 'In Casualty, a new alert appears with a chime: age group, sex and the danger signs. The team acknowledges it before he even arrives.',
  outro: 'That is Sahayak. Patients book from home and follow the queue in their own language. Clerks register in seconds. Doctors see the history and an AI summary before the patient walks in. Casualty is alerted the moment danger signs appear. And the hospital runs on fair, written queue rules.',
};

/* ------------------------------------------------------------------------------------------------ the stage page */
const STAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sahayak overview</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #0b1120; color: #e5e7eb;
    font-family: "Segoe UI", "Segoe UI Variable Text", system-ui, sans-serif; }
  #bg { position: absolute; inset: 0; background: radial-gradient(1200px 700px at 20% -10%, #1e2a4a 0%, #0b1120 60%); }
  #top { position: absolute; left: 0; top: 0; width: ${W}px; height: 64px; display: flex; align-items: center; padding: 0 28px; gap: 16px; }
  #top .mark { width: 34px; height: 34px; border-radius: 9px; background: linear-gradient(135deg, #14b8a6, #6366f1); display: grid; place-items: center; font-weight: 800; color: white; font-size: 18px; }
  #top .brand { font-size: 22px; font-weight: 700; letter-spacing: .2px; }
  #top .fac { color: #94a3b8; font-size: 16px; margin-left: 4px; }
  #scene { margin-left: auto; margin-right: auto; font-size: 20px; color: #cbd5e1; font-weight: 600; }
  #tag { color: #94a3b8; font-size: 15px; }
  #content { position: absolute; left: 0; top: 64px; width: ${W}px; height: ${H - 64 - 100}px; }
  .frame { position: absolute; opacity: 1; transition: left .35s ease, top .35s ease, width .35s ease, height .35s ease, opacity .3s ease; z-index: 2; }
  .frame.hidden { opacity: 0; pointer-events: none; z-index: 1; }
  .frame__bar { height: 36px; display: flex; align-items: center; gap: 10px; padding: 0 12px; font-size: 14px; color: #cbd5e1; font-weight: 600; }
  .frame__dots { display: inline-flex; gap: 5px; }
  .frame__dots i { width: 9px; height: 9px; border-radius: 50%; background: #334155; display: inline-block; }
  .frame--desk .frame__body { border: 1px solid rgba(255,255,255,.14); border-radius: 12px; overflow: hidden; background: #fff; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
  .frame--desk iframe { display: block; border: 0; width: 100%; height: 100%; background: #fff; }
  .frame--phone .frame__bar { justify-content: center; }
  .frame--phone .frame__body { width: 414px; height: 824px; padding: 12px; border-radius: 40px; background: #0f172a; border: 1px solid rgba(255,255,255,.18); box-shadow: 0 18px 50px rgba(0,0,0,.5); }
  .frame--phone iframe { display: block; border: 0; width: 390px; height: 800px; border-radius: 28px; background: #fff; }
  #card { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; text-align: center; background: #0b1120; opacity: 0; pointer-events: none; transition: opacity .3s ease; }
  #card.on { opacity: 1; }
  #card .tag { color: #5eead4; font-size: 20px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 18px; }
  #card .title { font-size: 72px; font-weight: 800; line-height: 1.1; letter-spacing: -.5px; }
  #card .sub { font-size: 30px; color: #94a3b8; margin-top: 18px; max-width: 1200px; }
  #caption { position: absolute; left: 0; bottom: 0; width: ${W}px; height: 100px; display: flex; align-items: center; padding: 0 48px; background: rgba(2, 6, 23, .92); border-top: 1px solid rgba(255,255,255,.08); }
  #caption .bar { width: 6px; height: 56px; border-radius: 3px; background: linear-gradient(#14b8a6, #6366f1); margin-right: 22px; flex: none; }
  #caption .text { font-size: 27px; line-height: 1.3; color: #f8fafc; }
  #cursor { position: absolute; left: 0; top: 0; z-index: 50; pointer-events: none; transform: translate(960px, 540px); transition: transform .45s cubic-bezier(.2,.8,.2,1); filter: drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
  #cursor .ripple { position: absolute; left: -14px; top: -14px; width: 36px; height: 36px; border-radius: 50%; border: 3px solid #14b8a6; opacity: 0; transform: scale(.3); }
  #cursor.click .ripple { animation: rip .45s ease-out; }
  @keyframes rip { 0% { opacity: .9; transform: scale(.3); } 100% { opacity: 0; transform: scale(1.4); } }
</style></head>
<body>
<div id="bg"></div>
<div id="top"><div class="mark">S</div><div class="brand">Sahayak</div><div class="fac" id="fac"></div><div id="scene"></div><div id="tag">Product overview</div></div>
<div id="content"><div id="card"><div><div class="tag" id="card-tag"></div><div class="title" id="card-title"></div><div class="sub" id="card-sub"></div></div></div></div>
<div id="caption"><div class="bar"></div><div class="text" id="caption-text"></div></div>
<div id="cursor"><div class="ripple"></div><svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.8 L11.6 21.5 L14.4 20.2 L11.4 13.6 L18 13.6 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
<script>
  const content = document.getElementById('content');
  const frames = {};
  window.__addFrame = (name, kind, title, src) => {
    const f = document.createElement('div');
    f.className = 'frame frame--' + kind + ' hidden';
    f.id = 'w-' + name;
    f.innerHTML = '<div class="frame__bar">' + (kind === 'desk' ? '<span class="frame__dots"><i></i><i></i><i></i></span>' : '') + '<span></span></div><div class="frame__body"></div>';
    f.querySelector('.frame__bar span:last-child').textContent = title;
    const ifr = document.createElement('iframe');
    ifr.id = 'f-' + name; ifr.name = name; ifr.src = src; ifr.setAttribute('allow', 'clipboard-write');
    f.querySelector('.frame__body').appendChild(ifr);
    f.style.left = '24px'; f.style.top = '16px';
    if (kind === 'phone') { f.style.width = '414px'; f.style.height = '860px'; }
    else { f.style.width = '1872px'; f.style.height = '884px'; }
    content.appendChild(f);
    frames[name] = f;
  };
  window.__setTitle = (name, title) => { frames[name].querySelector('.frame__bar span:last-child').textContent = title; };
  window.__layout = (spec, scene) => {
    for (const [name, f] of Object.entries(frames)) {
      const r = spec[name];
      if (!r) { f.classList.add('hidden'); continue; }
      f.classList.remove('hidden');
      f.style.left = r[0] + 'px'; f.style.top = r[1] + 'px';
      if (f.classList.contains('frame--desk')) {
        f.style.width = r[2] + 'px'; f.style.height = r[3] + 'px';
        f.querySelector('.frame__body').style.height = (r[3] - 36) + 'px';
      }
    }
    const card = document.getElementById('card');
    if (spec.card) {
      document.getElementById('card-tag').textContent = spec.card.tag || '';
      document.getElementById('card-title').textContent = spec.card.title || '';
      document.getElementById('card-sub').textContent = spec.card.sub || '';
      card.classList.add('on');
    } else card.classList.remove('on');
    if (scene != null) document.getElementById('scene').textContent = scene;
  };
  window.__caption = (text) => { document.getElementById('caption-text').textContent = text; };
  window.__facility = (text) => { document.getElementById('fac').textContent = text; };
  window.__cursor = (x, y, click) => {
    const c = document.getElementById('cursor');
    c.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    if (click) { c.classList.remove('click'); void c.offsetWidth; c.classList.add('click'); }
  };
</script>
</body></html>`;

/* ------------------------------------------------------------------------------------------------ helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (ms) => sleep(FAST ? Math.min(ms, 150) : ms);
const uniquePhone = (n) => `98765${String(Date.now() + n).slice(-5)}`;
const tokenAria = (code) => {
  const [prefix, number] = code.split('-');
  return `Token ${prefix.split('').join(' ')} ${number}`;
};
async function until(fn, timeout = 30_000, step = 250, what = 'condition') {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const textOf = async (loc) => ((await loc.textContent().catch(() => '')) || '').trim();
async function api(method, p, body) {
  const res = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/* ------------------------------------------------------------------------------------------------ narration (Windows TTS) */
function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12;
  let fmt;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') return { ...fmt, data: b.subarray(p + 8, p + 8 + size) };
    p += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${file}`);
}
function writeWav(file, samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
/** Synthesises every narration line once (22.05 kHz mono); returns { text → { file, ms } }. */
function synthesise(lines) {
  const dir = path.join(WORK, 'tts');
  fs.mkdirSync(dir, { recursive: true });
  const items = lines.map((text, i) => ({ text, path: path.join(dir, `line-${String(i).padStart(2, '0')}.wav`) }));
  const listFile = path.join(dir, 'lines.json');
  fs.writeFileSync(listFile, JSON.stringify(items));
  const ps = `
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try { $s.SelectVoice('${VOICE_NAME.replace(/'/g, "''")}') } catch { }
    $s.Rate = 1
    $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $items = Get-Content -Raw -Encoding UTF8 '${listFile.replace(/'/g, "''")}' | ConvertFrom-Json
    foreach ($i in $items) { $s.SetOutputToWaveFile($i.path, $fmt); $s.Speak($i.text); $s.SetOutputToNull() }
    $s.Dispose()
  `;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`text-to-speech failed: ${r.stderr || r.stdout}`);
  const out = {};
  for (const it of items) {
    const w = readWav(it.path);
    out[it.text] = { file: it.path, ms: Math.round((w.data.length / (w.rate * (w.bits / 8) * w.channels)) * 1000) };
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ main */
let dbgPage = null; // for the failure screenshot
async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const videoDir = path.join(WORK, 'video');
  fs.rmSync(videoDir, { recursive: true, force: true });

  console.log('● demo info and a fresh demo');
  const demo = await api('GET', '/dev/demo');
  await api('POST', '/dev/demo/reset', {});
  const keyOf = (kind) => (demo.devices.find((d) => d.kind === kind) || {}).key || '';
  const kioskKey = keyOf('kiosk');
  const displayKey = keyOf('queue_display');

  let voice = {};
  if (VOICE) {
    console.log('● synthesising the narration');
    voice = synthesise(Object.values(N));
  }

  const browser = await chromium.launch({ args: ['--disable-features=LocalNetworkAccessChecks'] });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: W, height: H } },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });
  // every frame: hide the purple Demo button, and give the kiosk and TV their device keys
  await context.addInitScript(
    ({ kioskKey, displayKey }) => {
      try {
        if (kioskKey) localStorage.setItem('sahayak.deviceKey.kiosk', kioskKey);
        if (displayKey) localStorage.setItem('sahayak.deviceKey.display', displayKey);
      } catch {}
      const hide = () => {
        const s = document.createElement('style');
        s.textContent = '.demo-fab{display:none!important}';
        (document.head || document.documentElement).appendChild(s);
      };
      if (document.head) hide();
      else document.addEventListener('DOMContentLoaded', hide);
    },
    { kioskKey, displayKey },
  );
  await context.route('http://localhost:5999/**', (route) => route.fulfill({ contentType: 'text/html', body: STAGE }));

  const page = await context.newPage();
  dbgPage = page;
  const t0 = Date.now();
  const captions = [];
  let narrationEnds = 0;
  await page.goto('http://localhost:5999/');
  await page.evaluate((name) => window.__facility(name), demo.facility.name);

  // ---- stage helpers
  const RECT = {
    phone: [24, 16, 414, 860],
    deskR: [462, 16, 1434, 884],
    desk: [24, 16, 1872, 884],
  };
  const show = async (spec, scene) => {
    const s = {};
    for (const [k, v] of Object.entries(spec)) s[k] = k === 'card' ? v : RECT[v];
    await page.evaluate(([s, scene]) => window.__layout(s, scene), [s, scene ?? null]);
    await pause(450);
  };
  /** Title card; the next layout is arranged behind it, so the frames are in place when it fades. */
  const card = async (tag, title, sub, scene, next = {}) => {
    const c = { tag, title, sub };
    await show({ card: c }, scene);
    await show({ ...next, card: c });
    await pause(2200);
    await show(next);
  };
  const cursorTo = async (x, y, click) => {
    await page.evaluate(([x, y, c]) => window.__cursor(x, y, c), [x, y, !!click]);
  };
  /** Shows a caption and speaks it (narration never overlaps: waits for the previous line to finish). */
  const say = async (text, { show: shown } = {}) => {
    const wait = narrationEnds - Date.now();
    if (wait > 0 && !FAST) await sleep(wait);
    const t = Date.now() - t0;
    const v = voice[text];
    const ms = v ? v.ms + 350 : FAST ? 150 : Math.max(2200, text.split(/\s+/).length * 330);
    narrationEnds = Date.now() + ms;
    captions.push({ t, text, file: v ? v.file : null });
    await page.evaluate((c) => window.__caption(c), shown || text);
    console.log(`  ${(t / 1000).toFixed(1).padStart(6)}s  ${text.slice(0, 90)}`);
  };
  const narrationDone = async () => {
    const wait = narrationEnds - Date.now();
    if (wait > 0) await sleep(wait);
  };
  const click = async (loc, { after = 350, force = false } = {}) => {
    await loc.waitFor({ state: 'visible', timeout: 30_000 });
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    const box = await loc.boundingBox();
    if (box) {
      await cursorTo(box.x + box.width / 2, box.y + box.height / 2, false);
      await pause(420);
      await cursorTo(box.x + box.width / 2, box.y + box.height / 2, true);
    }
    await loc.click({ force });
    await pause(after);
  };
  const type = async (loc, text, delay = 45) => {
    await click(loc, { after: 120 });
    await loc.pressSequentially(text, { delay: FAST ? 5 : delay });
    await pause(250);
  };
  const smoothScroll = async (loc, block = 'start') => {
    await loc.evaluate((el, block) => el.scrollIntoView({ behavior: 'smooth', block }), block).catch(() => {});
    await pause(900);
  };

  // ---- the screens
  const add = (name, kind, title, src) => page.evaluate(([n, k, t, s]) => window.__addFrame(n, k, t, s), [name, kind, title, src]);
  const staffUrl = (origin, email, screen) => `${origin}/login?as=${encodeURIComponent(email)}&returnTo=${encodeURIComponent(screen)}`;
  await add('patient', 'phone', 'Patient’s phone · Sunita’s son', `${A}/f/${FACILITY}`);
  await add('doctor', 'desk', 'Doctor · Dr. Anil Mehta · Medicine OPD · Room 1', staffUrl(B, 'dr.mehta@demo.sahayak.health', '/doctor'));
  await add('kiosk', 'desk', 'Gate kiosk', `${A}/kiosk`);
  await add('tv', 'desk', 'Waiting-hall TV', `${A}/display`);
  const P = page.frameLocator('#f-patient');
  const D = page.frameLocator('#f-doctor');
  const KI = page.frameLocator('#f-kiosk');
  const TV = page.frameLocator('#f-tv');
  let K; // counter (clerk), added in part 3
  let ED; // casualty board (nurse), added in part 6

  const sunitaPhone = uniquePhone(0);
  const rameshPhone = uniquePhone(7);

  // the doctor's console must be signed in and the TV online before the story starts
  await until(() => D.getByRole('button', { name: /^Call next/ }).isVisible(), 60_000, 300, 'doctor console');
  await until(() => TV.getByText('Now calling').isVisible(), 30_000, 300, 'waiting-hall TV');
  await until(() => KI.getByText('Scan your QR code').isVisible(), 30_000, 300, 'kiosk');
  await until(() => P.getByRole('link', { name: 'Start a visit' }).isVisible(), 30_000, 300, 'patient page');

  /* ---------- intro */
  await show({ card: { tag: 'Product overview', title: 'Sahayak', sub: 'The front door of a government hospital’s OPD' } }, '');
  await say(N.intro);
  await pause(1200);
  await show({ patient: 'phone', doctor: 'deskR' }, 'Before the day begins');
  await say(N.empty);
  await pause(600);

  /* ---------- part 1: Sunita books from home */
  await card('Part 1 of 6', 'Sunita books from home', 'The patient, on her son’s phone', 'Part 1 · Sunita books from home', { patient: 'phone', doctor: 'deskR' });
  await say(N.p1_start);
  await click(P.getByRole('link', { name: 'Start a visit' }));
  await say(N.p1_otp);
  await type(P.getByLabel('Mobile number'), sunitaPhone);
  await click(P.getByRole('button', { name: 'Send code' }));
  const codeEl = P.getByTestId('otp-dev-code');
  await codeEl.waitFor({ timeout: 30_000 });
  await pause(900);
  const otp = await textOf(codeEl);
  await type(P.getByLabel('6-digit code'), otp, 90);
  await click(P.getByRole('button', { name: 'Verify' }));

  const converse = async (decide) => {
    const done = P.getByRole('heading', { name: /Your visit is booked|Go to Casualty now/ });
    const cont = P.getByRole('button', { name: 'Continue' });
    const question = P.locator('.intake-question').last();
    for (let step = 0; step < 30; step++) {
      await until(async () => (await done.isVisible()) || (await question.isVisible()), 60_000, 200, 'next intake question');
      if (await done.isVisible()) return;
      await pause(300);
      const prompt = await textOf(question);
      const options = P.locator('.answer-option');
      const labels = (await options.allTextContents()).map((l) => l.trim());
      const answer = await decide(prompt.toLowerCase(), labels);
      if (labels.length) {
        const i = labels.findIndex((l) => l === answer);
        await click(options.nth(i >= 0 ? i : 0), { after: 250 });
      } else {
        await type(P.getByRole('textbox').first(), answer);
      }
      await click(cont, { after: 200 });
      await until(async () => (await done.isVisible()) || (await textOf(question)) !== prompt, 60_000, 200, 'intake reply');
    }
    throw new Error('intake did not finish');
  };

  let consentSaid = false;
  let whoSaid = false;
  let understoodSaid = false;
  let answersSaid = false;
  await converse(async (q, labels) => {
    if (labels.length) {
      if (/agree|computer assistant/.test(q)) {
        if (!consentSaid) await say(N.p1_consent);
        consentSaid = true;
        return 'Yes';
      }
      if (/who is this visit for/.test(q)) return 'Someone else';
      if (/sex/.test(q)) return 'Female';
      if (/related/.test(q)) return 'My parent';
      if (/what do you need/.test(q)) return 'New health problem';
      if (/long-term/.test(q)) return 'None';
      if (!understoodSaid) {
        await say(N.p1_understood);
        understoodSaid = true;
        await pause(2500);
      } else if (!answersSaid) {
        await say(N.p1_answers);
        answersSaid = true;
      }
      return 'No';
    }
    if (/full name/.test(q)) {
      if (!whoSaid) await say(N.p1_who);
      whoSaid = true;
      return 'Sunita Sharma';
    }
    if (/age/.test(q)) return '58';
    if (/describe/.test(q)) {
      await say(N.p1_describe);
      return 'fever and body ache since 2 days';
    }
    if (/since when/.test(q)) return '2 days';
    return '2';
  });
  await P.getByRole('heading', { name: 'Your visit is booked' }).waitFor();
  await say(N.p1_booked);
  await pause(2500);
  const checkinCode = await textOf(P.getByTestId('checkin-code'));
  await say(N.p1_decided);
  await smoothScroll(P.getByTestId('ai-decision'), 'start');
  await pause(5000);
  await say(N.p1_doctor_nothing);
  await pause(1500);

  /* ---------- part 2: the gate kiosk */
  await card('Part 2 of 6', 'She arrives at the gate', 'The kiosk at the hospital entrance', 'Part 2 · At the gate kiosk', { patient: 'phone', kiosk: 'deskR' });
  await say(N.p2_kiosk);
  await click(KI.getByRole('button', { name: 'Enter the check-in code' }));
  await type(KI.getByLabel('Enter the check-in code'), checkinCode, 30);
  await click(KI.getByRole('button', { name: 'Check in' }));
  await KI.getByRole('heading', { name: 'You are checked in' }).waitFor({ timeout: 30_000 });
  await say(N.p2_checked);
  const slipRef = await textOf(KI.locator('.slip-ref').last());
  const sunitaCode = (await api('GET', `/t/${slipRef}`)).token;
  await pause(2500);
  await say(N.p2_status);
  await smoothScroll(P.getByRole('link', { name: 'Close' }), 'center');
  await click(P.getByRole('link', { name: 'Close' }));
  await type(P.getByLabel('Enter the code on your slip'), slipRef, 60);
  await click(P.getByRole('button', { name: 'Continue' }));
  await P.getByText(/ahead of you|You are next/).waitFor({ timeout: 30_000 });
  await pause(800);
  await show({ patient: 'phone', doctor: 'deskR' });
  await say(N.p2_doctor);
  const railHas = async () => (await textOf(D.getByRole('navigation', { name: 'Queue' }))).includes(sunitaCode);
  await until(railHas, 45_000, 300, 'token on the doctor rail').catch(async () => {
    await page.frame({ name: 'doctor' }).evaluate(() => location.reload()); // the session is restored from the refresh token
    await until(railHas, 45_000, 300, 'token on the doctor rail (after reload)');
  });
  await pause(1500);

  /* ---------- part 3: a walk-in at the counter */
  await add('counter', 'desk', 'Registration counter · clerk', staffUrl(A, 'clerk@demo.sahayak.health', '/counter'));
  K = page.frameLocator('#f-counter');
  await until(() => K.getByRole('button', { name: /Register someone new/ }).isVisible(), 60_000, 300, 'counter screen');
  await card('Part 3 of 6', 'A walk-in at the counter', 'The registration clerk', 'Part 3 · The registration counter', { counter: 'desk' });
  await say(N.p3_counter);
  await click(K.getByRole('button', { name: /Register someone new/ }));
  await say(N.p3_register);
  await type(K.getByLabel('Full name'), 'Ramesh Patel');
  await click(K.locator('.ant-radio-button-wrapper', { hasText: /^Male$/ }));
  await type(K.getByRole('textbox', { name: 'Age' }), '72');
  await type(K.getByLabel('Mobile'), rameshPhone);
  await type(K.getByLabel('District'), '474');
  await click(K.getByRole('button', { name: 'Register', exact: true }));
  // a namesake from an earlier demo may exist: Ramesh is a new person, so he gets a fresh record (no old history)
  const different = K.getByRole('button', { name: 'This is a different person' });
  await until(async () => (await K.getByText('Selected patient').isVisible()) || (await different.isVisible()), 30_000, 250, 'registration');
  if (await different.isVisible()) {
    await click(different);
    await K.getByText('Selected patient').waitFor({ timeout: 30_000 });
  }
  await say(N.p3_checkin);
  await click(K.getByRole('button', { name: /Check in →/ }));
  const checked = K.getByRole('status').filter({ hasText: 'Checked in. Token' });
  await checked.waitFor({ timeout: 30_000 });
  const rameshCode = (await textOf(checked)).match(/Token ([A-Z]+-\d+)/)[1];
  await pause(1500);
  await say(N.p3_lane);
  await pause(1000);

  /* ---------- part 4: the doctor calls */
  await card('Part 4 of 6', 'The doctor calls', 'Dr. Anil Mehta, Medicine OPD, and the waiting hall', 'Part 4 · The doctor calls', { doctor: 'desk' });
  const callNext = D.getByRole('button', { name: /^Call next/ });
  const nowWithYou = D.getByText('Now with you').locator('..');
  await say(N.p4_lanes);
  await until(() => callNext.isEnabled(), 30_000, 250, 'Call next');
  await pause(3500);
  await click(callNext);
  await until(async () => (await textOf(nowWithYou)).includes(rameshCode), 30_000, 250, 'Ramesh called');
  await say(N.p4_ramesh);
  await pause(4000);
  await show({ tv: 'desk' });
  await say(N.p4_tv);
  await until(() => TV.getByRole('img', { name: tokenAria(rameshCode) }).isVisible(), 20_000, 250, 'token on the TV');
  await narrationDone();
  await pause(1200);
  await show({ patient: 'phone', doctor: 'deskR' });
  await say(N.p4_consult);
  await click(D.getByRole('button', { name: /^Start consult/ }));
  await until(() => D.getByRole('button', { name: /^Start consult/ }).isDisabled(), 20_000, 250, 'consult started');
  await pause(900);
  await click(D.getByRole('button', { name: /^Complete/ }));
  await click(D.getByRole('alertdialog').getByRole('button', { name: 'Complete' }));
  await until(() => callNext.isEnabled(), 30_000, 250, 'Call next again');
  await pause(900);
  await click(callNext);
  await until(async () => (await textOf(nowWithYou)).includes(sunitaCode), 30_000, 250, 'Sunita called');
  await say(N.p4_phone);
  await P.getByText(/Go to Room 1 now/).waitFor({ timeout: 20_000 });
  await pause(2500);
  await say(N.p4_card);
  // the AI summary: written while she waited; if the free LLM tier was busy, ask once more
  const summaryBox = D.locator('.prebrief__summary'); // the pre-brief's own summary (the visit history carries the same label)
  const summaryReady = async () => {
    if (await summaryBox.getByText('AI-generated, verify').first().isVisible()) return true;
    const again = summaryBox.getByRole('button', { name: 'Try again' });
    if (await again.isVisible()) {
      await click(again);
      await until(() => summaryBox.getByText('AI-generated, verify').first().isVisible(), 90_000, 500, 'AI summary (retry)').catch(() => {});
      return true;
    }
    return false;
  };
  await until(summaryReady, 90_000, 500, 'AI summary').catch(() => {});
  await smoothScroll(summaryBox, 'start');
  await pause(5000);
  await say(N.p4_guidelines);
  const considerations = D.getByTestId('ai-considerations');
  if (await considerations.isVisible().catch(() => false)) await smoothScroll(considerations, 'center');
  await pause(4000);
  await say(N.p4_diagnosis);
  await click(D.getByRole('button', { name: /^Diagnosis/ }));
  const dlg = D.getByRole('dialog');
  await type(dlg.getByLabel('Diagnosis'), 'Viral fever');
  await click(dlg.getByRole('button', { name: 'Save' }));
  await D.getByText('Diagnosis saved').waitFor({ timeout: 20_000 });
  await say(N.p4_rx);
  await click(D.getByRole('button', { name: /^Prescription/ }));
  await type(dlg.getByLabel('Medicine'), 'Paracetamol 500 mg');
  await type(dlg.getByLabel('Dose'), '1 tablet');
  await click(dlg.getByLabel('Frequency'), { force: true });
  await click(D.locator('.ant-select-item-option[title="TDS"]'));
  await type(dlg.getByLabel('Days'), '3');
  await type(dlg.getByLabel('Advice (optional)'), 'After food');
  await click(dlg.getByRole('button', { name: 'Save' }));
  await D.getByText('Prescription saved').waitFor({ timeout: 20_000 });
  await pause(800);
  await click(D.getByRole('button', { name: /^Complete/ }));
  await click(D.getByRole('alertdialog').getByRole('button', { name: 'Complete' }));
  await say(N.p4_done);
  await P.getByText('Visit complete').waitFor({ timeout: 20_000 });
  const visitCard = P.getByTestId('visit-card');
  await until(async () => (await textOf(visitCard)).includes('Paracetamol'), 20_000, 300, 'medicines on the phone');
  await smoothScroll(visitCard, 'end');
  await narrationDone();
  await pause(2500);

  /* ---------- part 5: Sunita comes back */
  // her phone a week later: signed out, back on the hospital page
  const pf = page.frame({ name: 'patient' });
  await pf.evaluate(() => sessionStorage.removeItem('sahayak.patient'));
  await pf.goto(`${A}/f/${FACILITY}`);
  await P.getByRole('link', { name: 'Start a visit' }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.__setTitle('patient', 'Patient’s phone · Sunita, a week later'));
  await card('Part 5 of 6', 'Sunita comes back', 'A returning patient: history and the AI summary on the doctor’s screen', 'Part 5 · Sunita comes back', { patient: 'phone', doctor: 'deskR' });
  await say(N.p5_back);
  await click(P.getByRole('link', { name: 'Start a visit' }));
  await type(P.getByLabel('Mobile number'), sunitaPhone);
  await click(P.getByRole('button', { name: 'Send code' }));
  await codeEl.waitFor({ timeout: 30_000 });
  await pause(600);
  await type(P.getByLabel('6-digit code'), await textOf(codeEl), 90);
  await click(P.getByRole('button', { name: 'Verify' }));
  let describedAgain = false;
  await converse(async (q, labels) => {
    if (labels.length) {
      if (/who is this visit for/.test(q)) return labels.find((l) => l.startsWith('Sunita')) || labels[0];
      if (/what do you need/.test(q)) return 'New health problem';
      if (/long-term/.test(q)) return 'None';
      return 'No';
    }
    if (/describe/.test(q)) {
      if (!describedAgain) await say(N.p5_booked);
      describedAgain = true;
      return 'headache since today';
    }
    return '1';
  });
  await P.getByRole('heading', { name: 'Your visit is booked' }).waitFor();
  await pause(1200);
  const revisitCode = await textOf(P.getByTestId('checkin-code'));
  await show({ patient: 'phone', kiosk: 'deskR' });
  await say(N.p5_kiosk);
  // the kiosk may still show the last slip, may be asking "Still there?", or may have reset itself to the scan screen
  const stillThere = KI.getByRole('button', { name: 'Start over' }).first();
  const takeSlip = KI.getByRole('button', { name: 'Take your slip' });
  if (await stillThere.isVisible().catch(() => false)) await click(stillThere);
  else if (await takeSlip.isVisible().catch(() => false)) await click(takeSlip);
  await click(KI.getByRole('button', { name: 'Enter the check-in code' }));
  await type(KI.getByLabel('Enter the check-in code'), revisitCode, 30);
  await click(KI.getByRole('button', { name: 'Check in' }));
  await KI.getByRole('heading', { name: 'You are checked in' }).waitFor({ timeout: 30_000 });
  await pause(1500);
  await show({ doctor: 'desk' });
  await say(N.p5_doctor);
  await until(() => callNext.isEnabled(), 30_000, 250, 'Call next (revisit)');
  await click(callNext);
  const history = D.getByTestId('visit-history');
  await until(async () => (await textOf(history)).includes('Viral fever'), 30_000, 300, 'visit history');
  await until(summaryReady, 90_000, 500, 'AI history summary').catch(() => {});
  await smoothScroll(summaryBox, 'start');
  await narrationDone();
  await pause(2500);
  await say(N.p5_history);
  await smoothScroll(history, 'start'); // the latest earlier visit is already expanded
  await narrationDone();
  await pause(2000);
  await click(D.getByRole('button', { name: /^Complete/ }));
  await click(D.getByRole('alertdialog').getByRole('button', { name: 'Complete' }));
  await show({ patient: 'phone', doctor: 'deskR' });
  await say(N.p5_phone);
  await smoothScroll(P.getByRole('link', { name: 'Close' }), 'center');
  await click(P.getByRole('link', { name: 'Close' }));
  await click(P.getByRole('link', { name: 'My visits and medicines' }));
  await until(async () => /Viral fever|Paracetamol/.test(await textOf(P.locator('body'))), 30_000, 300, 'my visits').catch(() => {});
  await narrationDone();
  await pause(2500);

  /* ---------- part 6: an emergency */
  await add('ed', 'desk', 'Casualty board · staff nurse', staffUrl(A, 'nurse@demo.sahayak.health', '/ed'));
  ED = page.frameLocator('#f-ed');
  await until(() => ED.getByText('Casualty pre-alerts').isVisible(), 60_000, 300, 'casualty board');
  await pf.goto(`${A}/f/${FACILITY}`);
  await P.getByRole('link', { name: 'Start a visit' }).waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.__setTitle('patient', 'Patient’s phone · now for Mahesh'));
  await card('Part 6 of 6', 'An emergency', 'Danger signs go straight to Casualty', 'Part 6 · An emergency', { patient: 'phone', ed: 'deskR' });
  await say(N.p6_start);
  await click(P.getByRole('link', { name: 'Start a visit' }));
  await converse(async (q, labels) => {
    if (labels.length) {
      if (/who is this visit for/.test(q)) return 'Someone else';
      if (/agree|computer assistant/.test(q)) return 'Yes';
      if (/sex/.test(q)) return 'Male';
      if (/related/.test(q)) return 'Spouse';
      if (/what do you need/.test(q)) return 'New health problem';
      return 'No';
    }
    if (/full name/.test(q)) return 'Mahesh Sharma';
    if (/age/.test(q)) return '61';
    return 'chest pain and sweating since 1 hour';
  });
  await P.getByRole('heading', { name: 'Go to Casualty now' }).waitFor();
  await say(N.p6_red);
  await pause(3000);
  await say(N.p6_ed);
  const ack = ED.getByRole('button', { name: 'Acknowledge' }).first();
  await ack.waitFor({ timeout: 30_000 });
  await pause(3500);
  await click(ack);
  await narrationDone();
  await pause(1500);

  /* ---------- outro */
  await show({ card: { tag: 'Sahayak', title: 'One front door for the OPD', sub: 'Patient · Kiosk · Waiting hall · Counter · Doctor · Casualty' } }, '');
  await say(N.outro);
  await narrationDone();
  await pause(2000);

  const video = page.video();
  await context.close();
  await browser.close();
  const webm = await video.path();
  const total = Date.now() - t0;
  fs.writeFileSync(path.join(OUT, 'captions.json'), JSON.stringify({ duration_ms: total, captions: captions.map(({ t, text }) => ({ t_ms: t, text })) }, null, 2));
  const res = { webm, captions, total };
  fs.writeFileSync(path.join(WORK, 'recording.json'), JSON.stringify(res)); // for --encode-only
  return res;
}

/* ------------------------------------------------------------------------------------------------ encode */
function encode({ webm, captions, total }) {
  const has = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0;
  const rawCopy = path.join(OUT, 'sahayak-overview.webm');
  if (!has) {
    fs.copyFileSync(webm, rawCopy);
    console.log(`ffmpeg not found: kept the raw recording at ${rawCopy}`);
    return;
  }
  const silent = path.join(OUT, 'sahayak-overview-silent.mp4');
  const narrated = path.join(OUT, 'sahayak-overview.mp4');
  const common = ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm];
  const vid = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart'];
  console.log('● encoding the silent mp4');
  let r = spawnSync('ffmpeg', [...common, ...vid, '-an', silent], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);

  const spoken = captions.filter((c) => c.file);
  if (!spoken.length) {
    fs.rmSync(narrated, { force: true });
    return;
  }
  console.log('● mixing the narration');
  const rate = 22050;
  const timeline = new Int16Array(Math.ceil(((total + 2000) / 1000) * rate));
  for (const c of spoken) {
    const w = readWav(c.file);
    const src = new Int16Array(w.data.buffer, w.data.byteOffset, Math.floor(w.data.length / 2));
    const at = Math.round((c.t / 1000) * rate);
    for (let i = 0; i < src.length && at + i < timeline.length; i++) timeline[at + i] = src[i];
  }
  const narrationWav = path.join(WORK, 'narration.wav');
  writeWav(narrationWav, timeline, rate);
  // 48 kHz stereo AAC-LC: the format every player handles (mono 22 kHz AAC stays silent in some Windows players)
  r = spawnSync(
    'ffmpeg',
    ['-y', '-hide_banner', '-loglevel', 'error', '-i', silent, '-i', narrationWav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '160k', '-shortest', '-movflags', '+faststart', narrated],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`ffmpeg (audio) failed: ${r.stderr}`);
}

// --encode-only: redo the mp4s from the last recording in --work (no browser, no new narration)
const run = args.includes('--encode-only') ? Promise.resolve(JSON.parse(fs.readFileSync(path.join(WORK, 'recording.json'), 'utf8'))) : main();
run
  .then((res) => {
    console.log(`● recorded ${(res.total / 1000 / 60).toFixed(1)} min`);
    encode(res);
    console.log(`● done → ${OUT}`);
  })
  .catch(async (e) => {
    console.error(e);
    if (dbgPage) {
      const shot = path.join(WORK, 'failure.png');
      await dbgPage.screenshot({ path: shot }).catch(() => {});
      for (const f of dbgPage.frames()) {
        const text = await f.locator('body').innerText({ timeout: 2000 }).catch(() => '');
        console.error(`  frame ${f.name() || '(top)'} ${f.url()}\n    ${text.replace(/\s+/g, ' ').slice(0, 500)}`);
      }
      console.error(`  screenshot: ${shot}`);
    }
    process.exit(1);
  });
