/*
 * decoder.js
 * Collects scanned frames (in any order, duplicates allowed) and rebuilds the original data.
 * Frame format is described in encoder.js.
 */
(function (root) {
  'use strict';

  var FRAME_RE = /^QS1\.([a-z0-9]{4})\.([a-z0-9]+)\.([a-z0-9]+)\.([A-Za-z0-9_-]*)$/;

  function Assembler() { this.reset(); }

  Assembler.prototype.reset = function () {
    this.session = null;
    this.total = 0;
    this.parts = [];
    this.count = 0;
  };

  /** @returns {{status:'ignored'|'duplicate'|'added'|'new-session', index?:number}} */
  Assembler.prototype.accept = function (text) {
    var m = FRAME_RE.exec(text || '');
    if (!m) return { status: 'ignored' };
    var sid = m[1], idx = parseInt(m[2], 36), total = parseInt(m[3], 36);
    if (!(total >= 1) || !(idx >= 0) || idx >= total) return { status: 'ignored' };

    var fresh = false;
    if (sid !== this.session || total !== this.total) {
      this.reset();
      this.session = sid;
      this.total = total;
      this.parts = new Array(total);
      fresh = true;
    }
    if (this.parts[idx] !== undefined) return { status: 'duplicate', index: idx };
    this.parts[idx] = m[4];
    this.count++;
    return { status: fresh ? 'new-session' : 'added', index: idx };
  };

  Assembler.prototype.has = function (i) { return this.parts[i] !== undefined; };
  Assembler.prototype.isComplete = function () { return this.total > 0 && this.count === this.total; };
  Assembler.prototype.missing = function () {
    var out = [];
    for (var i = 0; i < this.total; i++) if (this.parts[i] === undefined) out.push(i + 1);
    return out;
  };

  /** Rebuild the content. Throws if data is damaged. */
  Assembler.prototype.finish = async function () {
    if (!this.isComplete()) throw new Error('Not all frames have been scanned yet.');
    var stream = QREncoder.fromB64url(this.parts.join(''));
    if (stream.length < 7) throw new Error('The data is too short to be valid.');
    var flag = stream[0];
    var crc = ((stream[1] << 24) | (stream[2] << 16) | (stream[3] << 8) | stream[4]) >>> 0;
    var body = stream.subarray(5);
    if (flag === 1) body = await QREncoder.inflate(body);
    if (QREncoder.crc32(body) !== crc) throw new Error('The data was damaged during scanning. Try again.');

    var metaLen = (body[0] << 8) | body[1];
    var meta = JSON.parse(new TextDecoder().decode(body.subarray(2, 2 + metaLen)));
    var bytes = body.slice(2 + metaLen);
    var result = { kind: meta.k, name: meta.n, type: meta.t, bytes: bytes };
    if (meta.k === 'text') result.text = new TextDecoder().decode(bytes);
    return result;
  };

  root.QRDecoder = { Assembler: Assembler };
})(typeof window !== 'undefined' ? window : globalThis);
