// NULL-MODEM: ブラウザで動く 1200bps (V.22) ソフトウェアモデム
//
// 端末 (xterm.js) で AT コマンドを受け付け、ATDT で「電話をかける」。
// ダイヤルトーン → DTMF → 呼び出し音 → 応答音 → ハンドシェイク → CONNECT 1200 と音を鳴らし、
// 接続後は送受信のバイトを V.22 で変調した音にしながら (L = 送信 / R = 受信)、
// その速さ (1200bps) で WebSocket 経由の BBS とやりとりする。

import { SPEEDS } from "./v22.js";
import { XmodemSender, XmodemReceiver } from "./xmodem.js";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 端末

const term = new Terminal({
  cols: 80,
  rows: 25,
  // 端末は半角が全角のちょうど半分になる等幅フォントにする (ドット文字の DotGothic16 は
  // 半角が等幅でないので、xterm.js で文字が重なる)
  fontFamily: '"BIZ UDGothic", "Osaka-Mono", monospace',
  fontSize: 16,
  cursorBlink: true,
  cursorStyle: "block",
  allowTransparency: true,
  theme: {
    background: "rgba(0,0,0,0)",
    foreground: "#7cff8a",
    cursor: "#7cff8a",
    cursorAccent: "#06110a",
    selectionBackground: "rgba(124,255,138,0.3)",
    green: "#7cff8a",
    brightGreen: "#b6ffbf",
    yellow: "#ffb000",
    brightYellow: "#ffd466",
  },
});
// ドット文字のフォントが読み込まれてから端末を開く (先に開くと文字幅を測り違える)。
// フォントの CSS 自体がまだ届いていないこともあるので、先にそれを待つ
async function waitFonts() {
  const css = $("fonts-css");
  if (css && !css.sheet) await new Promise((r) => css.addEventListener("load", r, { once: true }));
  await document.fonts.load('16px "BIZ UDGothic"');
}
await Promise.race([waitFonts(), sleep(3000)]);
term.open($("terminal"));
// それでも後から読み込まれたときは、文字幅を測り直させる
const remeasure = () => {
  const family = term.options.fontFamily;
  term.options.fontFamily = "monospace";
  term.options.fontFamily = family;
};
document.fonts.addEventListener("loadingdone", remeasure);
const enc = new TextEncoder();
// 受信は 1 バイトずつ届くので、UTF-8 は自前で組み立ててから文字列で書く
// (xterm.js にバイトのまま細切れで渡すと、0x80 の続きバイトを取りこぼすことがある)
let rxDecoder = new TextDecoder("utf-8");
const writeBytes = (bytes) => term.write(rxDecoder.decode(bytes, { stream: true }));

/** 呼び出し音を何回鳴らしてからつながるか */
const RINGS = 3;
const say = (s) => term.write(s.replace(/\n/g, "\r\n"));

// ------------------------------------------------------------------ 設定と電話帳

let phonebook = [];
const settings = JSON.parse(localStorage.getItem("null-modem") || "{}");
function saveSettings() {
  localStorage.setItem("null-modem", JSON.stringify(settings));
}

async function loadConfig() {
  try {
    const r = await fetch("config.json");
    if (r.ok) phonebook = (await r.json()).phonebook || [];
  } catch {
    /* ローカルで静的に開いたときは電話帳なし */
  }
  const sp = $("speed");
  sp.innerHTML = "";
  for (const [k, v] of Object.entries(SPEEDS)) sp.add(new Option(v.label, k));
  sp.value = settings.speed && SPEEDS[settings.speed] ? settings.speed : "1200";
  const sel = $("phonebook");
  sel.innerHTML = "";
  for (const e of phonebook) sel.add(new Option(`${e.name} (${e.number})`, e.number));
  sel.add(new Option("手入力の接続先", "*"));
  $("custom-url").value = settings.url || "";
  $("custom-row").hidden = phonebook.length > 0 && sel.value !== "*";
}

/** 電話番号から接続先 URL を決める */
function resolve(number) {
  const dialed = number.replace(/\D/g, "");
  const e = phonebook.find((p) => p.number.replace(/\D/g, "") === dialed);
  if (e) return { url: e.url, name: e.name };
  if (settings.url) return { url: settings.url, name: settings.url };
  return null;
}

// ------------------------------------------------------------------ 音

let ctx = null;
let node = null;
let gain = null;
const analysers = {};

async function powerOn() {
  if (ctx) return;
  ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.audioWorklet.addModule("js/modem-worklet.js");
  node = new AudioWorkletNode(ctx, "modem-processor", { numberOfInputs: 0, outputChannelCount: [2] });
  gain = ctx.createGain();
  // 電話回線の帯域 (300Hz〜3.4kHz) に絞って、耳に刺さる成分を落とす
  const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 300, Q: 0.5 });
  const lp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 3400, Q: 0.5 });
  node.connect(hp).connect(lp).connect(gain).connect(ctx.destination);
  const split = ctx.createChannelSplitter(2);
  node.connect(split);
  for (const [i, ch] of [[0, "L"], [1, "R"]]) {
    const a = ctx.createAnalyser();
    a.fftSize = 2048;
    split.connect(a, i);
    analysers[ch] = a;
  }
  node.port.onmessage = (e) => onWorklet(e.data);
  updateVolume();
  led("MR", true);
  led("TR", true);
  $("power").classList.add("on");
  drawScopes();
  say("NULL-MODEM 1200 (V.22)\nOK\n");
}

const post = (m) => node && node.port.postMessage(m);
const tone = (ch, opts) => post({ type: "tone", ch, ...opts });
/** 受話器の「ガチャ」 */
const clunk = () => post({ type: "clunk" });
const silence = (ch) => post({ type: "silence", ch });

/** トーンを鳴らして終わるまで待つ */
function playTone(ch, opts) {
  return new Promise((resolve) => {
    toneWaiters[ch] = resolve;
    tone(ch, opts);
  });
}
const toneWaiters = {};

const DTMF = {
  1: [697, 1209], 2: [697, 1336], 3: [697, 1477], A: [697, 1633],
  4: [770, 1209], 5: [770, 1336], 6: [770, 1477], B: [770, 1633],
  7: [852, 1209], 8: [852, 1336], 9: [852, 1477], C: [852, 1633],
  "*": [941, 1209], 0: [941, 1336], "#": [941, 1477], D: [941, 1633],
};

// ------------------------------------------------------------------ モデムの状態

const modem = {
  state: "command", // command / dialing / online / escaped
  echo: true,
  speaker: 2, // ATM: 0 常に消音 / 1 接続まで鳴らす / 2 常に鳴らす
  volume: 3, // ATL: 0〜3
  line: "",
  lastCmd: "",
  ws: null,
  abort: null,
  txQueue: [], // 音にし終えたら WebSocket へ送る
  rxQueue: [], // 音にし終えたら画面に出す
  rxBefore: [], // +++ でコマンドモードにいる間に音にし終えた分
  rxHold: [], // CONNECT 前に届いた分 (接続してから流す)
  lastKey: 0,
  plus: 0,
  plusTimer: null,
  remoteClosed: false,
  speed: "1200", // 接続中の速度
  xfer: null, // XMODEM 転送中 { t, dir, name }
};

const speedSel = () => $("speed").value;

function led(name, on) {
  const el = document.querySelector(`.led[data-led="${name}"]`);
  if (el) el.classList.toggle("on", !!on);
}
const blinkTimers = {};
function blink(name) {
  led(name, true);
  clearTimeout(blinkTimers[name]);
  blinkTimers[name] = setTimeout(() => led(name, false), 60);
}

function updateVolume() {
  if (!gain) return;
  const vol = [0.08, 0.16, 0.28, 0.45][modem.volume] * Number($("volume").value) / 100;
  const audible = modem.speaker === 2 || (modem.speaker === 1 && modem.state === "dialing");
  gain.gain.setTargetAtTime(audible ? vol : 0, ctx.currentTime, 0.05);
}

function setState(s) {
  modem.state = s;
  $("status").textContent = {
    command: "コマンドモード",
    dialing: "発信中",
    online: `オンライン ${SPEEDS[modem.speed].label.replace(/ \(.*\)$/, "")}`,
    escaped: "オンライン (コマンドモード)",
  }[s];
  updateVolume();
}

function onWorklet(m) {
  if (m.type === "toneDone") {
    const w = toneWaiters[m.ch];
    delete toneWaiters[m.ch];
    if (w) w();
    return;
  }
  if (m.type !== "sent") return;
  if (m.ch === "L") {
    // 送信: 音にし終えたバイトを BBS へ (XMODEM の転送中も同じ経路)
    const bytes = modem.txQueue.splice(0, m.n);
    if (modem.ws && modem.ws.readyState === WebSocket.OPEN) modem.ws.send(new Uint8Array(bytes));
    blink("SD");
  } else {
    // 受信: 音にし終えたバイトを画面へ
    const bytes = modem.rxQueue.splice(0, m.n);
    if (modem.xfer) xferInput(bytes);
    else if (modem.state === "online") writeBytes(new Uint8Array(bytes));
    else modem.rxBefore.push(...bytes); // +++ で抜けている間はためておく
    blink("RD");
    if (m.pending === 0 && modem.remoteClosed) carrierLost();
  }
}

// ------------------------------------------------------------------ 発信と切断

function openSocket(url, signal) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(e);
      return;
    }
    ws.binaryType = "arraybuffer";
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("timeout"));
    }, 15000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("error"));
    };
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error("abort"));
    });
  });
}

async function dial(number) {
  if (!ctx) await powerOn();
  const dest = resolve(number);
  const abort = new AbortController();
  modem.abort = abort;
  modem.remoteClosed = false;
  modem.rxBefore = [];
  modem.rxHold = [];
  modem.rxQueue = [];
  rxDecoder = new TextDecoder("utf-8");
  modem.txQueue = [];
  setState("dialing");
  led("OH", true);
  clunk(); // 受話器を上げる
  post({ type: "line", offhook: true });
  const speed = speedSel();
  modem.speed = speed;
  const check = () => {
    if (abort.signal.aborted) throw new Error("abort");
  };
  try {
    await sleep(450);
    // ダイヤルトーン (400Hz) を聞いてからダイヤル
    await playTone("R", { freqs: [400], level: 0.12, dur: 1200 });
    check();
    for (const d of number.toUpperCase()) {
      if (DTMF[d]) {
        await playTone("L", { freqs: DTMF[d], level: 0.14, dur: 90 });
        await sleep(70);
      } else if (d === ",") {
        await sleep(2000);
      }
      check();
    }
    if (!dest) {
      await playTone("R", { freqs: [400], am: 16, on: 1000, off: 2000, level: 0.1, dur: 9000 });
      throw new Error("NO ANSWER");
    }
    $("dest").textContent = dest.name;
    // 呼び出し音 (400Hz を 16Hz で揺らす、1 秒鳴って 2 秒休む) を鳴らしながら接続
    tone("R", { freqs: [400], am: 16, on: 1000, off: 2000, level: 0.1 });
    const started = performance.now();
    let ws;
    try {
      ws = await openSocket(dest.url, abort.signal);
    } catch (e) {
      if (abort.signal.aborted) throw e;
      // 話し中の音 (400Hz、0.5 秒ずつ断続)
      await playTone("R", { freqs: [400], on: 500, off: 500, level: 0.1, dur: 3000 });
      throw new Error("BUSY");
    }
    modem.ws = ws;
    ws.onmessage = (e) => {
      const bytes = new Uint8Array(e.data);
      if (modem.state === "dialing") modem.rxHold.push(...bytes);
      else receive(bytes);
    };
    ws.onclose = () => {
      modem.remoteClosed = true;
      if (modem.state === "dialing") modem.abort?.abort();
      else if (modem.rxQueue.length === 0) carrierLost();
    };
    // 呼び出し音を RINGS 回鳴らしてから相手が出る (1 回 = 1 秒鳴って 2 秒休む)
    const ringFor = (RINGS - 1) * 3000 + 1000;
    const rang = performance.now() - started;
    if (rang < ringFor) await sleep(ringFor - rang);
    check();
    // 応答音 (2100Hz)
    silence("R");
    await sleep(300);
    await playTone("R", { freqs: [2100], level: 0.1, dur: 2600 });
    check();
    await sleep(75);
    await handshake(speed);
    check();
    led("CD", true);
    led("HS", speed !== "300");
    say(`\n${SPEEDS[speed].connect}\n`);
    setState("online");
    if (modem.rxHold.length) receive(new Uint8Array(modem.rxHold.splice(0)));
  } catch (e) {
    const msg = ["BUSY", "NO ANSWER"].includes(e.message) ? e.message : "NO CARRIER";
    hangup(false);
    say(`\n${msg}\n`);
  }
}

/** BBS から届いたバイトを受信側の音 (R) に流す。音にし終えたら画面に出る */
function receive(bytes) {
  modem.rxQueue.push(...bytes);
  post({ type: "push", ch: "R", bytes });
}

/** 回線が乱れて化けた文字 (NO CARRIER の前の演出) */
const GARBAGE = "~}{|`_^][\\@?>=<;:/.-,+*)('&%$#!ｱｲｳｴｵｶｷｸｹｺﾟﾞ｡｢｣､･ｦｧｨﾇﾈﾉ▒░¥";
async function garble() {
  tone("R", { noise: true, level: 0.06, dur: 700 });
  const n = 18 + Math.floor(Math.random() * 20);
  for (let i = 0; i < n; i++) {
    let s = "";
    for (let k = 0; k < 1 + Math.floor(Math.random() * 3); k++) s += GARBAGE[Math.floor(Math.random() * GARBAGE.length)];
    term.write(s);
    blink("RD");
    await sleep(8 + Math.random() * 30);
  }
}

let losing = false;
/** 速度ごとのハンドシェイクの音 */
async function handshake(speed) {
  const data = (ch, stage = "data") => post({ type: "data", ch, speed, role: ch === "L" ? "originate" : "answer", stage });
  if (speed === "300") {
    // V.21: 応答側のマーク (1650Hz) → 発信側のマーク (980Hz)
    data("R");
    await sleep(500);
    data("L");
    await sleep(600);
    return;
  }
  // V.22: 応答側 (2400Hz) → 発信側 (1200Hz)
  data("R", "v22");
  await sleep(500);
  data("L", "v22");
  await sleep(speed === "1200" ? 765 : 450);
  if (speed === "1200") return;
  // V.22bis: 16 点の信号に切り替える
  data("R");
  data("L");
  await sleep(600);
  if (speed === "2400mnp") {
    // MNP のリンク確立 (LR / LA フレームのやりとり)
    const frame = () => Array.from({ length: 20 }, () => Math.floor(Math.random() * 256));
    post({ type: "push", ch: "L", bytes: frame(), real: false });
    await sleep(250);
    post({ type: "push", ch: "R", bytes: frame(), real: false });
    await sleep(350);
  }
}

async function carrierLost() {
  if (modem.state === "command" || losing) return;
  losing = true;
  try {
    silence("L");
    if (modem.state === "online") await garble();
    hangup(false);
    say("\nNO CARRIER\n");
  } finally {
    losing = false;
  }
}

/** 回線を切る。`ok` なら OK を返す (ATH のとき) */
function hangup(ok) {
  modem.abort?.abort();
  modem.abort = null;
  if (modem.ws) {
    modem.ws.onclose = null;
    modem.ws.close();
    modem.ws = null;
  }
  if (modem.xfer) endXfer("回線が切れたので中止しました");
  silence("L");
  silence("R");
  post({ type: "line", offhook: false });
  if (modem.state !== "command") clunk(); // 受話器を置く
  for (const l of ["OH", "CD", "HS", "RD", "SD"]) led(l, false);
  $("dest").textContent = "-";
  setState("command");
  if (ok) say("\nOK\n");
}

// ------------------------------------------------------------------ AT コマンド

function info() {
  return `NULL-MODEM\n300bps V.21 / 1200bps V.22 / 2400bps V.22bis / MNP5\n速度: ${SPEEDS[speedSel()].label}\n`;
}

function execute(line) {
  let s = line.trim().toUpperCase().replace(/\s+/g, "");
  if (s === "A/") s = modem.lastCmd;
  if (!s) return;
  if (!s.startsWith("AT")) {
    say("ERROR\n");
    return;
  }
  modem.lastCmd = s;
  let i = 2;
  const num = () => {
    const m = /^\d*/.exec(s.slice(i))[0];
    i += m.length;
    return m === "" ? 0 : Number(m);
  };
  let out = "";
  while (i < s.length) {
    const c = s[i++];
    switch (c) {
      case "Z":
        modem.echo = true;
        modem.speaker = 2;
        modem.volume = 3;
        num();
        break;
      case "I":
        num();
        out += info();
        break;
      case "E":
        modem.echo = num() !== 0;
        break;
      case "M":
        modem.speaker = Math.min(2, num());
        break;
      case "L":
        modem.volume = Math.min(3, num());
        break;
      case "H":
        num();
        if (modem.state !== "command") {
          hangup(false);
        }
        break;
      case "O":
        num();
        if (modem.state === "escaped") {
          say("CONNECT 1200\n");
          setState("online");
          if (modem.rxBefore.length) writeBytes(new Uint8Array(modem.rxBefore.splice(0)));
          return;
        }
        say("NO CARRIER\n");
        return;
      case "D": {
        if (modem.state !== "command") {
          say("ERROR\n");
          return;
        }
        const number = s.slice(i).replace(/^[TP]/, "").replace(/[^0-9A-D*#,]/g, "");
        dial(number);
        return;
      }
      case "A":
        say("NO CARRIER\n"); // 着信は受けない
        return;
      case "X":
      case "V":
      case "Q":
      case "B":
        num();
        break;
      case "&": {
        const c2 = s[i++];
        const n = num();
        if (c2 === "N") {
          const k = ["300", "1200", "2400", "2400mnp"][n];
          if (!k) {
            say("ERROR\n");
            return;
          }
          $("speed").value = k;
          settings.speed = k;
          saveSettings();
        }
        break;
      }
      case "S":
        num();
        if (s[i] === "=") {
          i++;
          num();
        } else if (s[i] === "?") {
          i++;
          out += "000\n";
        }
        break;
      default:
        say("ERROR\n");
        return;
    }
  }
  updateVolume();
  say(out + "OK\n");
}

// ------------------------------------------------------------------ キー入力

function sendByte(bytes) {
  modem.txQueue.push(...bytes);
  post({ type: "push", ch: "L", bytes });
}

// ------------------------------------------------------------------ XMODEM

function human(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

function xferStatus() {
  const x = modem.xfer;
  if (!x) return;
  const p = x.t.progress;
  const total = p.total != null ? ` / ${human(p.total)}` : "";
  $("status").textContent = `XMODEM ${x.dir} ${x.name} ${human(p.bytes)}${total} 再送 ${p.errors}`;
}

/** XMODEM の相手に送るバイト (送信側の音 L を通る) */
function xferSend(bytes) {
  if (bytes.length) sendByte(Uint8Array.from(bytes));
}

function xferInput(bytes) {
  const x = modem.xfer;
  xferSend(x.t.input(bytes));
  xferStatus();
  if (!x.t.running) endXfer();
}

function endXfer(reason) {
  const x = modem.xfer;
  if (!x) return;
  modem.xfer = null;
  clearInterval(x.timer);
  if (reason && x.t.running) xferSend(x.t.cancel());
  const ok = x.t.state === "done";
  window.nullModem.lastXfer = x;
  say(`\n[XMODEM] ${reason || x.t.message}\n`);
  if (ok && x.dir === "受信") {
    const data = x.t.result();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = x.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    say(`[XMODEM] ${x.name} (${data.length} バイト) を保存しました\n`);
  }
  setState(modem.state);
}

function startXfer(t, dir, name, first = []) {
  modem.xfer = { t, dir, name, timer: setInterval(() => {
    const x = modem.xfer;
    if (!x) return;
    xferSend(x.t.tick(Date.now()));
    xferStatus();
    if (!x.t.running) endXfer();
  }, 100) };
  say(`\n[XMODEM] ${dir}を始めます (${name})。中止は Ctrl-X\n`);
  xferSend(first);
  xferStatus();
}

$("xsend").onclick = () => {
  if (modem.state !== "online" || modem.xfer) return say("\n[XMODEM] 接続中に使えます\n");
  $("xfile").value = "";
  $("xfile").click();
};
$("xfile").onchange = async () => {
  const f = $("xfile").files[0];
  if (!f) return;
  const data = new Uint8Array(await f.arrayBuffer());
  startXfer(new XmodemSender(data), "送信", f.name);
  term.focus();
};
$("xrecv").onclick = () => {
  if (modem.state !== "online" || modem.xfer) return say("\n[XMODEM] 接続中に使えます\n");
  const name = (settings.lastRecv || "download.bin").replace(/[\\/]/g, "_");
  const t = new XmodemReceiver();
  startXfer(t, "受信", name, t.start());
  term.focus();
};

function onlineInput(data) {
  if (modem.xfer) {
    // 転送中は Ctrl-X か Esc で中止。ほかのキーは送らない
    if (data === "\x18" || data === "\x1b") endXfer("中止しました");
    return;
  }
  const now = performance.now();
  // +++ (前後に 1 秒の無入力) でコマンドモードへ
  if (data === "+" && (modem.plus > 0 || now - modem.lastKey > 1000)) {
    modem.plus++;
    modem.lastKey = now;
    clearTimeout(modem.plusTimer);
    if (modem.plus === 3) {
      modem.plusTimer = setTimeout(() => {
        modem.plus = 0;
        setState("escaped");
        say("\nOK\n");
      }, 1000);
    } else {
      modem.plusTimer = setTimeout(flushPlus, 1000);
    }
    return;
  }
  flushPlus();
  modem.lastKey = now;
  sendByte(enc.encode(data));
}

function flushPlus() {
  clearTimeout(modem.plusTimer);
  if (modem.plus > 0) sendByte(enc.encode("+".repeat(modem.plus)));
  modem.plus = 0;
}

term.onData((data) => {
  if (!ctx) {
    powerOn();
    return;
  }
  if (modem.state === "online") return onlineInput(data);
  if (modem.state === "dialing") {
    // 発信中に何か押したら中止
    hangup(false);
    say("\nNO CARRIER\n");
    return;
  }
  for (const ch of data) {
    if (ch === "\r") {
      if (modem.echo) say("\n");
      const line = modem.line;
      modem.line = "";
      execute(line);
    } else if (ch === "\x7f" || ch === "\b") {
      if (modem.line.length > 0) {
        modem.line = modem.line.slice(0, -1);
        if (modem.echo) term.write("\b \b");
      }
    } else if (ch >= " ") {
      modem.line += ch;
      if (modem.echo) term.write(ch);
    }
  }
});

// ------------------------------------------------------------------ 波形表示

function drawScopes() {
  const buf = new Float32Array(2048);
  const frame = () => {
    for (const ch of ["L", "R"]) {
      const cv = $(`scope-${ch}`);
      const g = cv.getContext("2d");
      const a = analysers[ch];
      const color = ch === "L" ? "255,176,0" : "124,255,138";
      // 残光のように前の波形を少し残す
      g.fillStyle = "rgba(4,10,6,0.55)";
      g.fillRect(0, 0, cv.width, cv.height);
      // 目盛り
      g.strokeStyle = "rgba(120,160,130,0.12)";
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= 10; x++) {
        g.moveTo((x * cv.width) / 10, 0);
        g.lineTo((x * cv.width) / 10, cv.height);
      }
      for (let y = 0; y <= 4; y++) {
        g.moveTo(0, (y * cv.height) / 4);
        g.lineTo(cv.width, (y * cv.height) / 4);
      }
      g.stroke();
      if (!a) continue;
      a.getFloatTimeDomainData(buf);
      g.strokeStyle = `rgba(${color},0.95)`;
      g.lineWidth = 2.5;
      g.shadowColor = `rgba(${color},0.9)`;
      g.shadowBlur = 10;
      g.beginPath();
      const n = 600;
      for (let x = 0; x < n; x++) {
        const y = cv.height / 2 - buf[x] * cv.height * 1.8;
        const px = (x / n) * cv.width;
        x ? g.lineTo(px, y) : g.moveTo(px, y);
      }
      g.stroke();
      g.shadowBlur = 0;
    }
    requestAnimationFrame(frame);
  };
  frame();
}

// ------------------------------------------------------------------ ボタン

$("power").onclick = async () => {
  await powerOn();
  term.focus();
};
$("dial").onclick = async () => {
  await powerOn();
  if (modem.state !== "command") return;
  const sel = $("phonebook").value;
  const number = sel === "*" ? "0" : sel;
  const cmd = `ATDT${number}`;
  say(cmd + "\n");
  execute(cmd);
  term.focus();
};
$("hangup").onclick = () => {
  if (modem.state === "online") carrierLost();
  else if (modem.state !== "command") {
    hangup(false);
    say("\nNO CARRIER\n");
  }
  term.focus();
};
$("volume").oninput = updateVolume;
$("speed").onchange = () => {
  settings.speed = $("speed").value;
  saveSettings();
};
$("phonebook").onchange = () => {
  $("custom-row").hidden = $("phonebook").value !== "*";
};
$("custom-url").onchange = () => {
  settings.url = $("custom-url").value.trim();
  saveSettings();
};

loadConfig();
say("POWER スイッチを入れてください (何かキーを押しても入ります)\n");
term.focus();

// デバッグ用 (ブラウザの開発ツールから状態を見られるように)
window.nullModem = { term, modem, startXfer, XmodemSender, XmodemReceiver };
