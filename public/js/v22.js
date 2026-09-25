// ITU-T V.22 (1200bps 全二重) の送信側
//
// - 非同期の 1 文字を 10 ビット (スタート 0、データ 8 ビット LSB から、ストップ 1) にする
// - スクランブラ 1 + x^-14 + x^-17 でかき混ぜる
// - 2 ビットずつ 600 ボーの差動位相変調 (DPSK) で送る
//     00 → +90°  01 → 0°  11 → +270°  10 → +180°
// - キャリアは発信側 1200Hz、応答側 2400Hz
//
// AudioWorklet の中でも Node のテストでも動くよう、依存のない素の JS にしている。

export const BAUD = 600;
export const ORIGINATE_HZ = 1200;
export const ANSWER_HZ = 2400;

/** 2 ビット (先に送るビットが b1) の位相変化 (度) */
export function phaseChange(b1, b2) {
  if (b1 === 0 && b2 === 0) return 90;
  if (b1 === 0 && b2 === 1) return 0;
  if (b1 === 1 && b2 === 1) return 270;
  return 180; // 10
}

/** 位相変化 (度) から 2 ビットに戻す */
export function dibitFromPhase(deg) {
  const d = ((Math.round(deg / 90) % 4) + 4) % 4;
  return [[0, 1], [0, 0], [1, 0], [1, 1]][d];
}

/** 1 バイトを非同期フレームのビット列に */
export function byteBits(b) {
  const bits = [0];
  for (let i = 0; i < 8; i++) bits.push((b >> i) & 1);
  bits.push(1);
  return bits;
}

/** 自己同期スクランブラ (1 + x^-14 + x^-17) */
export class Scrambler {
  constructor() { this.reg = 0; }
  scramble(bit) {
    const out = bit ^ ((this.reg >> 13) & 1) ^ ((this.reg >> 16) & 1);
    this.reg = ((this.reg << 1) | out) & 0x1ffff;
    return out;
  }
}

export class Descrambler {
  constructor() { this.reg = 0; }
  descramble(bit) {
    const out = bit ^ ((this.reg >> 13) & 1) ^ ((this.reg >> 16) & 1);
    this.reg = ((this.reg << 1) | bit) & 0x1ffff;
    return out;
  }
}

/**
 * V.22 の変調器。sample() を呼ぶたびに 1 サンプル返す。
 * push() したバイトを送り終えるたびに sent が増える (呼び出し側が読んで 0 に戻す)。
 * バイトが無いときはマーク (1) を送り続ける (キャリアは出たまま)。
 */
export class V22Modulator {
  constructor(sampleRate, carrierHz) {
    this.sampleRate = sampleRate;
    this.carrierHz = carrierHz;
    this.samplesPerSym = sampleRate / BAUD;
    this.scr = new Scrambler();
    this.queue = [];
    this.bits = [];
    this.bitsAreByte = false;
    this.sent = 0;
    this.carrier = 0; // キャリアの位相 (ラジアン)
    this.symAngle = 0; // 今のシンボルの位相 (度)
    this.prevI = 1; this.prevQ = 0;
    this.curI = 1; this.curQ = 0;
    this.pos = this.samplesPerSym; // 最初の sample() で次のシンボルへ
  }

  push(bytes) {
    for (const b of bytes) this.queue.push(b & 0xff);
  }

  /** まだ送っていないバイト数 */
  get pending() {
    return this.queue.length + (this.bitsAreByte && this.bits.length > 0 ? 1 : 0);
  }

  nextBit() {
    if (this.bits.length === 0) {
      if (this.queue.length > 0) {
        this.bits = byteBits(this.queue.shift());
        this.bitsAreByte = true;
      } else {
        this.bits = [1];
        this.bitsAreByte = false;
      }
    }
    const bit = this.bits.shift();
    if (this.bitsAreByte && this.bits.length === 0) this.sent++;
    return bit;
  }

  nextSymbol() {
    const b1 = this.scr.scramble(this.nextBit());
    const b2 = this.scr.scramble(this.nextBit());
    this.symAngle = (this.symAngle + phaseChange(b1, b2)) % 360;
    const rad = (this.symAngle * Math.PI) / 180;
    this.prevI = this.curI; this.prevQ = this.curQ;
    this.curI = Math.cos(rad); this.curQ = Math.sin(rad);
  }

  sample() {
    if (this.pos >= this.samplesPerSym) {
      this.pos -= this.samplesPerSym;
      this.nextSymbol();
    }
    // シンボルの前半で滑らかに位相を移し (二乗余弦)、後半は一定にする
    const t = this.pos / this.samplesPerSym;
    const w = t < 0.5 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * t) : 1;
    const i = this.prevI + (this.curI - this.prevI) * w;
    const q = this.prevQ + (this.curQ - this.prevQ) * w;
    const s = i * Math.cos(this.carrier) - q * Math.sin(this.carrier);
    this.carrier += (2 * Math.PI * this.carrierHz) / this.sampleRate;
    if (this.carrier > 2 * Math.PI) this.carrier -= 2 * Math.PI;
    this.pos += 1;
    return s;
  }
}
