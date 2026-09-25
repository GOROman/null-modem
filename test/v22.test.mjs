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
