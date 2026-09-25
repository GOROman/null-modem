// ソフトウェアモデムの変調器
//
// 文字をビット列にする「フレーマ」と、ビット列を音にする「変調器」に分けている。
//
// フレーマ
//   AsyncFramer : 非同期 (スタート 0 / データ 8 ビット LSB から / ストップ 1)。1 文字 10 ビット
//   MnpFramer   : MNP (同期なのでスタート・ストップ無し)。MNP5 の適応圧縮の符号長とフレームの付加分を再現する
// 変調器
//   V21Modulator    : 300bps FSK (V.21)
//   V22Modulator    : 1200bps DPSK (V.22)。600 ボー × 2 ビット
//   V22bisModulator : 2400bps 16QAM (V.22bis)。600 ボー × 4 ビット
//
// どれも sample() で 1 サンプルずつ返し、実データのバイトを送り終えるたびに sent が増える。
// AudioWorklet の中でも Node のテストでも動くよう、依存のない素の JS にしている。

export const BAUD = 600;
export const ORIGINATE_HZ = 1200;
export const ANSWER_HZ = 2400;

/** V.21 の周波数 (マーク = 1、スペース = 0) */
export const V21 = {
  originate: { mark: 980, space: 1180 },
  answer: { mark: 1650, space: 1850 },
};

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

// ------------------------------------------------------------------ フレーマ

class Framer {
  constructor() {
    this.queue = []; // { b, real }
    this.bits = [];
    this.bitsAreReal = false;
    this.sent = 0;
  }
  /** 送るバイト。real = false は手順用のダミー (sent に数えない) */
  push(bytes, real = true) {
    for (const b of bytes) this.queue.push({ b: b & 0xff, real });
  }
  get pending() {
    const q = this.queue.filter((x) => x.real).length;
    return q + (this.bitsAreReal && this.bits.length > 0 ? 1 : 0);
  }
  nextBit() {
    if (this.bits.length === 0) {
      if (this.queue.length > 0) {
        const { b, real } = this.queue.shift();
        this.bits = this.frame(b);
        this.bitsAreReal = real;
      } else {
        this.bits = [1];
        this.bitsAreReal = false;
      }
    }
    const bit = this.bits.shift();
    if (this.bitsAreReal && this.bits.length === 0) this.sent++;
    return bit;
  }
}

export class AsyncFramer extends Framer {
  frame(b) {
    return byteBits(b);
  }
}

/**
 * MNP (エラー訂正 + MNP5 圧縮) の送り方を再現する。
 * - 同期転送なので 1 文字 8 ビット (スタート・ストップ無し)
 * - MNP5 の適応頻度符号: 出現回数の多い文字ほど順位が上がり、短い符号になる
 *   (順位 0〜1 は 4 ビット、それ以降は 3 ビットの頭 + 順位の桁数)
 * - 同じ文字が 3 つ続いたら、その後は回数 1 バイトにまとめる (ランレングス)
 * - 64 文字ごとにフレームの頭とチェック (7 バイト相当) が付く
 */
export class MnpFramer extends Framer {
  constructor(compress = true) {
    super();
    this.compress = compress;
    this.rank = Array.from({ length: 256 }, (_, i) => i); // 順位 → 文字
    this.pos = Array.from({ length: 256 }, (_, i) => i); // 文字 → 順位
    this.count = new Array(256).fill(0);
    this.last = -1;
    this.run = 0;
    this.inFrame = 0;
  }

  /** MNP5 の符号長 (ビット) を求め、表を更新する */
  codeLength(b) {
    const r = this.pos[b];
    const len = r < 2 ? 4 : 3 + Math.floor(Math.log2(r)) + 1;
    // 出現回数を数えて、上の順位の文字より多くなったら入れ替える
    this.count[b]++;
    let p = r;
    while (p > 0 && this.count[this.rank[p - 1]] < this.count[b]) {
      const other = this.rank[p - 1];
      this.rank[p] = other;
      this.pos[other] = p;
      p--;
    }
    this.rank[p] = b;
    this.pos[b] = p;
    return len;
  }

  frame(b) {
    let len = 8;
    if (this.compress) {
      if (b === this.last) this.run++;
      else {
        this.last = b;
        this.run = 1;
      }
      // 3 つ目までは普通に送り、4 つ目以降は回数 1 バイトにまとめるので 0 ビット (まとめて最後に 8 ビット)
      len = this.run > 3 ? (this.run === 4 ? 8 : 0) : this.codeLength(b);
    }
    const bits = [];
    for (let i = 0; i < len; i++) bits.push((b >> (i % 8)) & 1);
    this.inFrame++;
    if (this.inFrame >= 64) {
      this.inFrame = 0;
      for (let i = 0; i < 56; i++) bits.push((0x7e >> (i % 8)) & 1); // フレームの頭とチェック
    }
    // 0 ビットの文字でも「送り終えた」ことは知らせる必要があるので、最低 1 ビットにする
    return bits.length ? bits : [1];
  }
}

// ------------------------------------------------------------------ 変調器

/** V.21 (300bps FSK)。位相が連続した周波数切り替え */
export class V21Modulator {
  constructor(sampleRate, { mark, space }, framer = new AsyncFramer()) {
    this.sampleRate = sampleRate;
    this.mark = mark;
    this.space = space;
    this.framer = framer;
    this.samplesPerBit = sampleRate / 300;
    this.pos = this.samplesPerBit;
    this.phase = 0;
    this.bit = 1;
  }
  push(bytes, real) { this.framer.push(bytes, real); }
  get sent() { return this.framer.sent; }
  set sent(v) { this.framer.sent = v; }
  get pending() { return this.framer.pending; }
  sample() {
    if (this.pos >= this.samplesPerBit) {
      this.pos -= this.samplesPerBit;
      this.bit = this.framer.nextBit();
    }
    this.pos += 1;
    const f = this.bit ? this.mark : this.space;
    this.phase += (2 * Math.PI * f) / this.sampleRate;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return Math.sin(this.phase);
  }
}

/** 600 ボーの位相系変調 (V.22 と V.22bis) の共通部分 */
class PskModulator {
  constructor(sampleRate, carrierHz, framer) {
    this.sampleRate = sampleRate;
    this.carrierHz = carrierHz;
    this.framer = framer;
    this.samplesPerSym = sampleRate / BAUD;
    this.scr = new Scrambler();
    this.carrier = 0;
    this.quadrant = 0; // 今のシンボルの象限の位相 (度)
    this.prevI = 1; this.prevQ = 0;
    this.curI = 1; this.curQ = 0;
    this.pos = this.samplesPerSym;
  }
  push(bytes, real) { this.framer.push(bytes, real); }
  get sent() { return this.framer.sent; }
  set sent(v) { this.framer.sent = v; }
  get pending() { return this.framer.pending; }
  bit() {
    return this.scr.scramble(this.framer.nextBit());
  }
  setPoint(i, q) {
    this.prevI = this.curI; this.prevQ = this.curQ;
    this.curI = i; this.curQ = q;
  }
  sample() {
    if (this.pos >= this.samplesPerSym) {
      this.pos -= this.samplesPerSym;
      this.nextSymbol();
    }
    // シンボルの前半で滑らかに移り (二乗余弦)、後半は一定にする
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

/** V.22 (1200bps)。2 ビットで位相を 0/90/180/270° 変える */
export class V22Modulator extends PskModulator {
  constructor(sampleRate, carrierHz, framer = new AsyncFramer()) {
    super(sampleRate, carrierHz, framer);
  }
  nextSymbol() {
    const b1 = this.bit();
    const b2 = this.bit();
    this.quadrant = (this.quadrant + phaseChange(b1, b2)) % 360;
    const rad = (this.quadrant * Math.PI) / 180;
    this.setPoint(Math.cos(rad), Math.sin(rad));
  }
}

/** V.22bis の象限内の点 (第 1 象限、後ろ 2 ビット → 座標) */
export const V22BIS_POINTS = { "00": [1, 1], "01": [3, 1], "10": [1, 3], "11": [3, 3] };

/** V.22bis (2400bps)。前 2 ビットで象限を変え、後ろ 2 ビットで象限内の 4 点から選ぶ (16QAM) */
export class V22bisModulator extends PskModulator {
  constructor(sampleRate, carrierHz, framer = new AsyncFramer()) {
    super(sampleRate, carrierHz, framer);
    this.quadrant = 45;
  }
  nextSymbol() {
    const b1 = this.bit(), b2 = this.bit(), b3 = this.bit(), b4 = this.bit();
    this.quadrant = (this.quadrant + phaseChange(b1, b2)) % 360;
    const [x, y] = V22BIS_POINTS[`${b3}${b4}`];
    // 第 1 象限の点 (x, y) を、象限の位相 (45° が第 1 象限) まで回す
    const rot = ((this.quadrant - 45) * Math.PI) / 180;
    const i = (x * Math.cos(rot) - y * Math.sin(rot)) / 3.2;
    const q = (x * Math.sin(rot) + y * Math.cos(rot)) / 3.2;
    this.setPoint(i, q);
  }
}

// ------------------------------------------------------------------ 速度の定義

/** 選べる速度 */
export const SPEEDS = {
  300: { label: "300bps (V.21)", connect: "CONNECT 300" },
  1200: { label: "1200bps (V.22)", connect: "CONNECT 1200" },
  2400: { label: "2400bps (V.22bis)", connect: "CONNECT 2400" },
  "2400mnp": { label: "2400bps MNP5 (V.22bis)", connect: "CONNECT 2400/REL5" },
};

/**
 * 速度と役割 (originate: 発信側 / answer: 応答側) から変調器を作る。
 * `stage` が "v22" のときは 2400bps でもハンドシェイク用に V.22 で送る
 */
export function makeModulator(sampleRate, speed, role, stage = "data") {
  const carrier = role === "originate" ? ORIGINATE_HZ : ANSWER_HZ;
  if (speed === "300") return new V21Modulator(sampleRate, V21[role]);
  if (speed === "1200" || stage === "v22") return new V22Modulator(sampleRate, carrier);
  if (speed === "2400mnp") return new V22bisModulator(sampleRate, carrier, new MnpFramer(true));
  return new V22bisModulator(sampleRate, carrier);
}
