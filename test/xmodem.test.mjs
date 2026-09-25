// XMODEM の送信側と受信側を直結して転送させる
import { test } from "node:test";
import assert from "node:assert/strict";
import { XmodemSender, XmodemReceiver, crc16 } from "../public/js/xmodem.js";

test("CRC-16 (XMODEM)", () => assert.equal(crc16(new TextEncoder().encode("123456789")), 0x31c3));

function run(data, corrupt = -1) {
  let now = 0;
  const tx = new XmodemSender(data, { now });
  const rx = new XmodemReceiver({ now });
  let toTx = rx.start(), n = 0;
  while ((tx.running || rx.running) && n++ < 100000) {
    let toRx = tx.input(toTx, now);
    if (n === corrupt && toRx.length > 10) toRx = toRx.map((b, i) => (i === 10 ? b ^ 0xff : b));
    toTx = rx.input(toRx, now);
    if (!toTx.length && !toRx.length) { now += 1000; toTx = [...rx.tick(now), ...rx.input(tx.tick(now), now)]; }
  }
  return { tx, rx };
}

for (const len of [0, 1, 127, 128, 129, 1000, 5000]) {
  test(`${len} バイトのファイルを送受信できる`, () => {
    const data = Uint8Array.from({ length: len }, (_, i) => (i * 7) % 251);
    const { tx, rx } = run(data);
    assert.equal(tx.state, "done", tx.message);
    assert.equal(rx.state, "done", rx.message);
    assert.deepEqual(rx.result(), data);
  });
}

test("壊れたブロックは再送される", () => {
  const data = Uint8Array.from({ length: 600 }, (_, i) => i & 0xff);
  const { tx, rx } = run(data, 3);
  assert.equal(rx.state, "done");
  assert.deepEqual(rx.result(), data);
});
