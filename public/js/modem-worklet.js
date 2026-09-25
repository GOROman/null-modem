// モデムの音を作る AudioWorklet (ステレオ: L = 送信 / R = 受信)
//
// メインスレッドからの指示:
//   { type: "tone", ch, freqs, level, on, off, am, dur }  トーン (on/off はミリ秒の断続、am は振幅変調の Hz)
//   { type: "data", ch, speed, role, stage }               キャリアを出し始める (データが無ければマーク)
//   { type: "push", ch, bytes, real }                      送るバイト (real = false は手順用のダミー)
//   { type: "line", offhook }                              回線につながっている間は回線の雑音を足す
//   { type: "silence", ch }
//   { type: "clunk" }                                      受話器を上げ下ろしする「ガチャ」(両チャンネル)
//   tone に noise: true を付けるとホワイトノイズ (回線の雑音)
// メインスレッドへの通知:
//   { type: "sent", ch, n, pending }   n バイトを音にし終えた (その時点で相手に届いたことにする)
//   { type: "toneDone", ch }           dur 付きのトーンが終わった

import { makeModulator } from "./v22.js";

/** 速度ごとの音量 (変調方式で振幅が違うのをそろえる) */
const DATA_LEVEL = { 300: 0.09, 1200: 0.1, 2400: 0.08, "2400mnp": 0.08 };

class Voice {
  constructor(sr) {
    this.sr = sr;
    this.mode = "off";
    this.pending = []; // キャリアを出す前に届いたバイト
  }

  tone({ freqs = [], level = 0.2, on = 0, off = 0, am = 0, dur = 0, noise = false }) {
    this.mode = "tone";
    this.freqs = freqs;
    this.noise = noise;
    this.level = level;
    this.onN = on ? Math.round((on * this.sr) / 1000) : 0;
    this.offN = off ? Math.round((off * this.sr) / 1000) : 0;
    this.am = am;
    this.durN = dur ? Math.round((dur * this.sr) / 1000) : 0;
    this.n = 0;
  }

  data({ speed, role, stage }) {
    // ハンドシェイクで方式が変わっても、送りかけのバイトは引き継ぐ
    const carry = this.mode === "data" ? this.mod.framer.queue : [];
    this.mode = "data";
    this.mod = makeModulator(this.sr, speed, role, stage);
    this.level = DATA_LEVEL[speed] ?? 0.1;
    for (const { b, real } of carry) this.mod.push([b], real);
    this.mod.push(this.pending, true);
    this.pending = [];
  }

  push(bytes, real = true) {
    if (this.mode === "data") this.mod.push(bytes, real);
    else if (real) for (const b of bytes) this.pending.push(b);
  }

  silence() {
    this.mode = "off";
    this.pending = [];
  }

  /** 1 サンプル。dur のトーンが終わったら "done" を返す */
  sample() {
    if (this.mode === "data") return this.mod.sample() * this.level;
    if (this.mode !== "tone") return 0;
    const n = this.n++;
    if (this.durN && n >= this.durN) {
      this.mode = "off";
      return "done";
    }
    if (this.onN && n % (this.onN + this.offN) >= this.onN) return 0;
    const t = n / this.sr;
    let s = 0;
    if (this.noise) {
      s = Math.random() * 2 - 1;
    } else {
      for (const f of this.freqs) s += Math.sin(2 * Math.PI * f * t);
      s /= this.freqs.length;
    }
    if (this.am) s *= 0.5 + 0.5 * Math.sin(2 * Math.PI * this.am * t);
    return s * this.level;
  }
}

/** 受話器の「ガ・チャ」: 2 回のカチッという音と、低い「ゴトッ」を合成する */
class Clunk {
  constructor(sr) {
    this.sr = sr;
    this.n = -1;
    this.lp = 0;
  }
  start() {
    this.n = 0;
  }
  sample() {
    if (this.n < 0) return 0;
    const t = this.n++ / this.sr;
    if (t > 0.35) {
      this.n = -1;
      return 0;
    }
    let s = 0;
    // 「ガ」: 最初の接点の音
    if (t < 0.04) s += (Math.random() * 2 - 1) * Math.exp(-t / 0.006) * 0.9;
    // 「チャ」: 70ms 後にもう一度鳴る少し明るい音
    const t2 = t - 0.07;
    if (t2 >= 0 && t2 < 0.05) s += (Math.random() * 2 - 1) * Math.exp(-t2 / 0.01) * 0.6;
    // 本体が揺れる低い音
    s += Math.sin(2 * Math.PI * 110 * t) * Math.exp(-t / 0.05) * 0.5;
    // こもらせる (一次のローパス)
    this.lp += (s - this.lp) * 0.35;
    return this.lp * 0.35;
  }
}

class ModemProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = { L: new Voice(sampleRate), R: new Voice(sampleRate) };
    this.clunk = new Clunk(sampleRate);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "clunk") {
        this.clunk.start();
        return;
      }
      if (m.type === "line") {
        this.offhook = m.offhook;
        return;
      }
      const v = this.voices[m.ch];
      if (!v) return;
      if (m.type === "tone") v.tone(m);
      else if (m.type === "data") v.data(m);
      else if (m.type === "push") v.push(m.bytes, m.real !== false);
      else if (m.type === "silence") v.silence();
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    // ガチャは両チャンネルに同じ音を足す
    const clunk = new Float32Array(out[0].length);
    for (let i = 0; i < clunk.length; i++) clunk[i] = this.clunk.sample();
    const chans = [["L", out[0]], ["R", out[1] || out[0]]];
    for (const [ch, buf] of chans) {
      const v = this.voices[ch];
      for (let i = 0; i < buf.length; i++) {
        const s = v.sample();
        if (s === "done") {
          buf[i] = 0;
          this.port.postMessage({ type: "toneDone", ch });
        } else {
          buf[i] = s + clunk[i];
        }
      }
      if (v.mode === "data" && v.mod.sent > 0) {
        this.port.postMessage({ type: "sent", ch, n: v.mod.sent, pending: v.mod.pending });
        v.mod.sent = 0;
      }
    }
    this.phoneLine(out[0], out[1] || out[0]);
    return true;
  }

  /**
   * 電話回線の音質にする:
   * 送受信の回り込み、回線の雑音、軽い歪み、電話網と同じ 8kHz・8 ビット μ-law での量子化。
   * (帯域 300Hz〜3.4kHz への制限はメインスレッドのフィルタで行う)
   */
  phoneLine(L, R) {
    const hold = Math.max(1, Math.round(sampleRate / 8000));
    const MU = 255;
    const mulaw = (x) => {
      x = Math.tanh(x * 1.4) / 1.4; // 軽い歪み
      const y = (Math.sign(x) * Math.log1p(MU * Math.abs(x))) / Math.log1p(MU);
      const q = Math.round(y * 127) / 127; // 8 ビット
      return (Math.sign(q) * Math.expm1(Math.abs(q) * Math.log1p(MU))) / MU;
    };
    for (let i = 0; i < L.length; i++) {
      let l = L[i], r = R[i];
      if (this.offhook) {
        // 2 線式回線での回り込み (自分の送信が少し聞こえる) と、サーッという雑音
        const xl = l + r * 0.12, xr = r + l * 0.12;
        l = xl + (Math.random() - 0.5) * 0.006;
        r = xr + (Math.random() - 0.5) * 0.006;
      }
      // 8kHz サンプリングの再現 (hold サンプルごとに値を更新)
      if ((this.holdN = ((this.holdN ?? 0) + 1) % hold) === 0 || this.holdL === undefined) {
        this.holdL = mulaw(l);
        this.holdR = mulaw(r);
      }
      L[i] = this.holdL;
      if (R !== L) R[i] = this.holdR;
    }
  }
}

registerProcessor("modem-processor", ModemProcessor);
