// モデムの音を作る AudioWorklet (ステレオ: L = 送信 / R = 受信)
//
// メインスレッドからの指示:
//   { type: "tone", ch, freqs, level, on, off, am, dur }  トーン (on/off はミリ秒の断続、am は振幅変調の Hz)
//   { type: "data", ch, carrier }                          V.22 のキャリアを出し始める (データが無ければマーク)
//   { type: "push", ch, bytes }                            送るバイト (1200bps で音にする)
//   { type: "silence", ch }
// メインスレッドへの通知:
//   { type: "sent", ch, n, pending }   n バイトを音にし終えた (その時点で相手に届いたことにする)
//   { type: "toneDone", ch }           dur 付きのトーンが終わった

import { V22Modulator } from "./v22.js";

class Voice {
  constructor(sr) {
    this.sr = sr;
    this.mode = "off";
    this.pending = []; // キャリアを出す前に届いたバイト
  }

  tone({ freqs, level = 0.2, on = 0, off = 0, am = 0, dur = 0 }) {
    this.mode = "tone";
    this.freqs = freqs;
    this.level = level;
    this.onN = on ? Math.round((on * this.sr) / 1000) : 0;
    this.offN = off ? Math.round((off * this.sr) / 1000) : 0;
    this.am = am;
    this.durN = dur ? Math.round((dur * this.sr) / 1000) : 0;
    this.n = 0;
  }

  data(carrier) {
    this.mode = "data";
    this.mod = new V22Modulator(this.sr, carrier);
    this.mod.push(this.pending);
    this.pending = [];
  }

  push(bytes) {
    if (this.mode === "data") this.mod.push(bytes);
    else for (const b of bytes) this.pending.push(b);
  }

  silence() {
    this.mode = "off";
    this.pending = [];
  }

  /** 1 サンプル。dur のトーンが終わったら "done" を返す */
  sample() {
    if (this.mode === "data") return this.mod.sample() * 0.18;
    if (this.mode !== "tone") return 0;
    const n = this.n++;
    if (this.durN && n >= this.durN) {
      this.mode = "off";
      return "done";
    }
    if (this.onN && n % (this.onN + this.offN) >= this.onN) return 0;
    const t = n / this.sr;
    let s = 0;
    for (const f of this.freqs) s += Math.sin(2 * Math.PI * f * t);
    s /= this.freqs.length;
    if (this.am) s *= 0.5 + 0.5 * Math.sin(2 * Math.PI * this.am * t);
    return s * this.level;
  }
}

class ModemProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = { L: new Voice(sampleRate), R: new Voice(sampleRate) };
    this.port.onmessage = (e) => {
      const m = e.data;
      const v = this.voices[m.ch];
      if (!v) return;
      if (m.type === "tone") v.tone(m);
      else if (m.type === "data") v.data(m.carrier);
      else if (m.type === "push") v.push(m.bytes);
      else if (m.type === "silence") v.silence();
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const chans = [["L", out[0]], ["R", out[1] || out[0]]];
    for (const [ch, buf] of chans) {
      const v = this.voices[ch];
      for (let i = 0; i < buf.length; i++) {
        const s = v.sample();
        if (s === "done") {
          buf[i] = 0;
          this.port.postMessage({ type: "toneDone", ch });
        } else {
          buf[i] = s;
        }
      }
      if (v.mode === "data" && v.mod.sent > 0) {
        this.port.postMessage({ type: "sent", ch, n: v.mod.sent, pending: v.mod.pending });
        v.mod.sent = 0;
      }
    }
    return true;
  }
}

registerProcessor("modem-processor", ModemProcessor);
