// V.22 変調器のテスト: 変調した音を復調し直して元のバイト列に戻るか確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BAUD, ORIGINATE_HZ, ANSWER_HZ, V22Modulator, Scrambler, Descrambler, byteBits, dibitFromPhase, phaseChange,
} from "../public/js/v22.js";

const SR = 48000;

/** 同期検波で各シンボルの位相を取り出し、ビット列に戻す */
function demodulate(samples, carrierHz) {
  const sps = SR / BAUD;
  const nsym = Math.floor(samples.length / sps);
  const angles = [];
  for (let k = 0; k < nsym; k++) {
    let i = 0, q = 0;
    const from = Math.ceil(k * sps + sps * 0.6), to = Math.floor(k * sps + sps * 0.95);
    for (let n = from; n < to; n++) {
      const ph = (2 * Math.PI * carrierHz * n) / SR;
      i += samples[n] * Math.cos(ph);
      q -= samples[n] * Math.sin(ph);
    }
    angles.push((Math.atan2(q, i) * 180) / Math.PI);
  }
  const bits = [];
  let prev = 0; // 変調器は位相 0 から始まる
  const d = new Descrambler();
  for (const a of angles) {
    const [b1, b2] = dibitFromPhase(a - prev);
    prev = a;
    bits.push(d.descramble(b1), d.descramble(b2));
  }
  return bits;
}

/** 非同期フレーム (スタート 0 / データ 8 / ストップ 1) からバイトを取り出す */
function unframe(bits) {
  const out = [];
  for (let i = 0; i + 9 < bits.length; ) {
    if (bits[i] !== 0) { i++; continue; }
    let b = 0;
    for (let k = 0; k < 8; k++) b |= bits[i + 1 + k] << k;
    assert.equal(bits[i + 9], 1, "ストップビット");
    out.push(b);
    i += 10;
  }
  return out;
}

function run(carrierHz, bytes, idleSymbols = 20) {
  const m = new V22Modulator(SR, carrierHz);
  m.push(bytes);
  const n = Math.ceil(((bytes.length * 10) / 2 + idleSymbols) * (SR / BAUD));
  const s = new Float32Array(n);
  for (let k = 0; k < n; k++) s[k] = m.sample();
  return { s, m };
}

test("スクランブラとデスクランブラは元に戻る", () => {
  const s = new Scrambler(), d = new Descrambler();
  const bits = Array.from({ length: 500 }, (_, i) => (i * 7 + (i >> 3)) & 1);
  assert.deepEqual(bits.map((b) => d.descramble(s.scramble(b))), bits);
});

test("位相変化とビットの対応 (V.22 の表どおり)", () => {
  for (const b of [[0, 0], [0, 1], [1, 1], [1, 0]]) assert.deepEqual(dibitFromPhase(phaseChange(...b)), b);
  assert.deepEqual(byteBits(0x41), [0, 1, 0, 0, 0, 0, 0, 1, 0, 1]);
});

for (const hz of [ORIGINATE_HZ, ANSWER_HZ]) {
  test(`${hz}Hz キャリアで変調して復調すると元のバイト列に戻る`, () => {
    const text = new TextEncoder().encode("ATDT0\r\nこんにちは NULL-BBS! \x00\xff");
    const { s, m } = run(hz, text);
    assert.equal(m.sent, text.length, "送り終えたバイト数");
    assert.deepEqual(unframe(demodulate(s, hz)), Array.from(text));
  });
}

test("1200bps の速さで送る (1 秒で 120 文字)", () => {
  const m = new V22Modulator(SR, ORIGINATE_HZ);
  m.push(new Uint8Array(500));
  for (let k = 0; k < SR; k++) m.sample();
  assert.ok(m.sent >= 119 && m.sent <= 120, `1 秒で ${m.sent} 文字`);
});

test("エネルギーがキャリア周波数の近くに集まっている", () => {
  const { s } = run(ANSWER_HZ, new Uint8Array(200).map((_, i) => i));
  const power = (f) => {
    let i = 0, q = 0;
    for (let n = 0; n < s.length; n++) {
      i += s[n] * Math.cos((2 * Math.PI * f * n) / SR);
      q += s[n] * Math.sin((2 * Math.PI * f * n) / SR);
    }
    return i * i + q * q;
  };
  assert.ok(power(2400) > 20 * power(1200), "2400Hz 付近が 1200Hz より十分強い");
});

// ---------------------------------------------------------------- V.21 / V.22bis / MNP
import { V21, V21Modulator, V22bisModulator, V22BIS_POINTS, MnpFramer, AsyncFramer, makeModulator } from "../public/js/v22.js";

/** V.21: ビットの中ほどでマークとスペースのどちらが強いかを比べる */
function demodV21(samples, { mark, space }) {
  const spb = SR / 300;
  const bits = [];
  const power = (f, from, to) => {
    let i = 0, q = 0;
    for (let n = from; n < to; n++) { i += samples[n] * Math.cos((2 * Math.PI * f * n) / SR); q += samples[n] * Math.sin((2 * Math.PI * f * n) / SR); }
    return i * i + q * q;
  };
  for (let k = 0; (k + 1) * spb <= samples.length; k++) {
    const from = Math.ceil(k * spb + spb * 0.2), to = Math.floor(k * spb + spb * 0.8);
    bits.push(power(mark, from, to) > power(space, from, to) ? 1 : 0);
  }
  return bits;
}

for (const role of ["originate", "answer"]) {
  test(`V.21 (300bps ${role}) で変調して復調すると元に戻る`, () => {
    const text = new TextEncoder().encode("CONNECT 300 テスト\xff");
    const m = new V21Modulator(SR, V21[role]);
    m.push(text);
    const s = new Float32Array(Math.ceil((text.length * 10 + 30) * (SR / 300)));
    for (let k = 0; k < s.length; k++) s[k] = m.sample();
    assert.equal(m.sent, text.length);
    assert.deepEqual(unframe(demodV21(s, V21[role])), Array.from(text));
  });
}

/** V.22bis: 同期検波で点を取り出し、象限の変化と象限内の点からビットに戻す */
function demodV22bis(samples, carrierHz) {
  const sps = SR / BAUD;
  const d = new Descrambler();
  const bits = [];
  let prevQuad = 45;
  for (let k = 0; (k + 1) * sps <= samples.length; k++) {
    let i = 0, q = 0, n0 = 0;
    for (let n = Math.ceil(k * sps + sps * 0.6); n < Math.floor(k * sps + sps * 0.95); n++, n0++) {
      const ph = (2 * Math.PI * carrierHz * n) / SR;
      i += samples[n] * Math.cos(ph);
      q -= samples[n] * Math.sin(ph);
    }
    i = (i * 2 * 3.2) / n0; q = (q * 2 * 3.2) / n0;
    const ang = (Math.atan2(q, i) * 180) / Math.PI;
    const quad = ((Math.floor(ang / 90) * 90 + 45) % 360 + 360) % 360;
    const [b1, b2] = dibitFromPhase(quad - prevQuad);
    prevQuad = quad;
    const rot = ((quad - 45) * Math.PI) / 180;
    const x = i * Math.cos(-rot) - q * Math.sin(-rot), y = i * Math.sin(-rot) + q * Math.cos(-rot);
    const key = Object.entries(V22BIS_POINTS).sort((a, b) => Math.hypot(a[1][0] - x, a[1][1] - y) - Math.hypot(b[1][0] - x, b[1][1] - y))[0][0];
    for (const b of [b1, b2, +key[0], +key[1]]) bits.push(d.descramble(b));
  }
  return bits;
}

for (const hz of [ORIGINATE_HZ, ANSWER_HZ]) {
  test(`V.22bis (2400bps, ${hz}Hz) で変調して復調すると元に戻る`, () => {
    const text = new TextEncoder().encode("CONNECT 2400 ２４００ビーピーエス\x00\xff");
    const m = new V22bisModulator(SR, hz);
    m.push(text);
    const s = new Float32Array(Math.ceil((text.length * 10 / 4 + 20) * (SR / BAUD)));
    for (let k = 0; k < s.length; k++) s[k] = m.sample();
    assert.equal(m.sent, text.length);
    assert.deepEqual(unframe(demodV22bis(s, hz)), Array.from(text));
  });
}

/** 1 秒間に送れる文字数 */
function charsPerSecond(mod, data) {
  mod.push(data);
  for (let k = 0; k < SR * 2; k++) mod.sample();
  return mod.sent / 2;
}

test("速度ごとの 1 秒あたりの文字数", () => {
  const text = new TextEncoder().encode("パソコン通信の BBS へようこそ。掲示板・メール・チャットが使えます。\r\n".repeat(40));
  const rates = Object.fromEntries(["300", "1200", "2400", "2400mnp"].map((sp) => [sp, charsPerSecond(makeModulator(SR, sp, "answer"), text)]));
  assert.ok(Math.abs(rates["300"] - 30) <= 1, `300bps: ${rates["300"]}`);
  assert.ok(Math.abs(rates["1200"] - 120) <= 1, `1200bps: ${rates["1200"]}`);
  assert.ok(Math.abs(rates["2400"] - 240) <= 2, `2400bps: ${rates["2400"]}`);
  assert.ok(rates["2400mnp"] > 330, `MNP5 はスタート・ストップ無し + 圧縮で速い: ${rates["2400mnp"]}`);
});

test("MNP の手順用ダミーは送信済みに数えない", () => {
  const f = new MnpFramer(true);
  f.push([1, 2, 3], false);
  f.push([4, 5], true);
  for (let i = 0; i < 400; i++) f.nextBit();
  assert.equal(f.sent, 2);
  assert.equal(new AsyncFramer().pending, 0);
});
