// XMODEM (128 バイトブロック、CRC-16 / チェックサム) の送受信
//
// I/O を持たない状態機械。受信したバイトを input() に、時間経過を tick() に渡すと、
// 相手に送るバイト列を返す。null-term (Rust) の transfer.rs を移植したもの。

const SOH = 0x01, EOT = 0x04, ACK = 0x06, NAK = 0x15, CAN = 0x18, CRC_REQ = 0x43, SUB = 0x1a;

export function crc16(data) {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function packet(blk, payload, crc) {
  const data = new Uint8Array(128).fill(SUB);
  data.set(payload);
  const p = [SOH, blk & 0xff, ~blk & 0xff, ...data];
  if (crc) {
    const c = crc16(data);
    p.push(c >> 8, c & 0xff);
  } else {
    p.push(data.reduce((a, b) => (a + b) & 0xff, 0));
  }
  return p;
}

const cancelBytes = () => [CAN, CAN, CAN, CAN, CAN];

/** 送信側 */
export class XmodemSender {
  /** `ackTimeout`: 応答を待つ秒数 (遅い回線では長めに) */
  constructor(data, { ackTimeout = 15, now = Date.now() } = {}) {
    this.data = data;
    this.pos = 0;
    this.blk = 1;
    this.crc = true;
    this.state = "start"; // start / ack / eot / done / failed
    this.last = [];
    this.ackTimeout = ackTimeout * 1000;
    this.deadline = now + 60000;
    this.errors = 0;
    this.cans = 0;
    this.message = "";
  }
  get running() { return this.state !== "done" && this.state !== "failed"; }
  get progress() { return { bytes: Math.min(this.pos, this.data.length), total: this.data.length, errors: this.errors }; }

  fail(msg, out) {
    out.push(...cancelBytes());
    this.state = "failed";
    this.message = msg;
  }

  sendBlock(now, out) {
    if (this.pos >= this.data.length) {
      this.last = [EOT];
      this.state = "eot";
    } else {
      this.last = packet(this.blk, this.data.subarray(this.pos, this.pos + 128), this.crc);
      this.state = "ack";
    }
    out.push(...this.last);
    this.deadline = now + this.ackTimeout;
  }

  input(bytes, now = Date.now()) {
    const out = [];
    for (const b of bytes) {
      if (!this.running) break;
      if (b === CAN) {
        if (++this.cans >= 2) {
          this.state = "failed";
          this.message = "相手が中止しました";
        }
        continue;
      }
      this.cans = 0;
      if (this.state === "start") {
        if (b === CRC_REQ || b === NAK) {
          this.crc = b === CRC_REQ;
          this.sendBlock(now, out);
        }
      } else if (b === ACK) {
        this.errors = 0;
        if (this.state === "eot") {
          this.state = "done";
          this.message = "送信が完了しました";
        } else {
          this.pos += 128;
          this.blk = (this.blk + 1) & 0xff;
          this.sendBlock(now, out);
        }
      } else if (b === NAK) {
        if (++this.errors > 10) this.fail("再送が多すぎます", out);
        else {
          out.push(...this.last);
          this.deadline = now + this.ackTimeout;
        }
      }
    }
    return out;
  }

  tick(now = Date.now()) {
    const out = [];
    if (!this.running || now < this.deadline) return out;
    if (this.state === "start") this.fail("受信側が応答しません", out);
    else if (++this.errors > 10) this.fail("応答がありません", out);
    else {
      out.push(...this.last);
      this.deadline = now + this.ackTimeout;
    }
    return out;
  }

  cancel() {
    const out = [];
    if (this.running) this.fail("中止しました", out);
    return out;
  }
}

/** 受信側 */
export class XmodemReceiver {
  constructor({ ackTimeout = 15, now = Date.now() } = {}) {
    this.crc = true;
    this.expect = 1;
    this.buf = [];
    this.chunks = [];
    this.held = null; // 最後のブロックの詰め物 (SUB) を取り除くため 1 つ保留する
    this.started = false;
    this.tries = 1;
    this.ackTimeout = ackTimeout * 1000;
    this.deadline = now + 3000;
    this.errors = 0;
    this.cans = 0;
    this.state = "running";
    this.message = "";
    this.bytes = 0;
  }
  /** 最初に送る開始合図 */
  start() { return [CRC_REQ]; }
  get running() { return this.state === "running"; }
  get progress() { return { bytes: this.bytes, total: null, errors: this.errors }; }

  fail(msg, out) {
    out.push(...cancelBytes());
    this.state = "failed";
    this.message = msg;
  }

  packetLen() { return 3 + 128 + (this.crc ? 2 : 1); }

  /** 受け取ったファイルの中身 (末尾の SUB を除く) */
  result() {
    const total = this.chunks.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  input(bytes, now = Date.now()) {
    const out = [];
    for (const b of bytes) {
      if (!this.running) break;
      if (this.buf.length === 0) {
        if (b === SOH) { this.buf.push(b); this.cans = 0; }
        else if (b === EOT) this.onEot(out);
        else if (b === CAN && ++this.cans >= 2) { this.state = "failed"; this.message = "相手が中止しました"; }
        continue;
      }
      this.buf.push(b);
      if (this.buf.length === this.packetLen()) {
        const p = this.buf;
        this.buf = [];
        this.onPacket(p, now, out);
      }
    }
    return out;
  }

  onPacket(p, now, out) {
    this.started = true;
    this.deadline = now + this.ackTimeout;
    const body = p.slice(3, 131);
    const ok = p[1] === (~p[2] & 0xff) && (this.crc
      ? ((crc16(body) >> 8) === p[131] && (crc16(body) & 0xff) === p[132])
      : body.reduce((a, b) => (a + b) & 0xff, 0) === p[131]);
    if (!ok) return this.nak(out);
    if (p[1] === ((this.expect - 1) & 0xff)) { out.push(ACK); return; } // 再送
    if (p[1] !== this.expect) return this.fail("ブロック番号が飛びました", out);
    if (this.held) this.chunks.push(this.held);
    this.held = Uint8Array.from(body);
    this.bytes += 128;
    this.expect = (this.expect + 1) & 0xff;
    this.errors = 0;
    out.push(ACK);
  }

  nak(out) {
    if (++this.errors > 10) this.fail("受信エラーが多すぎます", out);
    else out.push(NAK);
  }

  onEot(out) {
    if (this.held) {
      let end = this.held.length;
      while (end > 0 && this.held[end - 1] === SUB) end--;
      this.chunks.push(this.held.subarray(0, end));
      this.held = null;
    }
    out.push(ACK);
    this.state = "done";
    this.message = "受信が完了しました";
  }

  tick(now = Date.now()) {
    const out = [];
    if (!this.running || now < this.deadline) return out;
    if (!this.started) {
      if (++this.tries > 20) { this.fail("送信側が応答しません", out); return out; }
      if (this.tries > 3) this.crc = false; // C に反応がなければチェックサム方式
      out.push(this.crc ? CRC_REQ : NAK);
      this.deadline = now + 3000;
      return out;
    }
    this.buf = [];
    this.nak(out);
    this.deadline = now + this.ackTimeout;
    return out;
  }

  cancel() {
    const out = [];
    if (this.running) this.fail("中止しました", out);
    return out;
  }
}
