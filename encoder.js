/*
 * encoder.js
 * Turns text or a file into a list of short text frames, each small enough for one QR code.
 *
 * Frame format:   QS1.<session>.<index>.<total>.<payload>
 *   session  4 random base36 chars (lets the receiver notice a new transfer)
 *   index    frame number, base36, starting at 0
 *   total    number of frames, base36
 *   payload  base64url slice of the packed stream
 *
 * Packed stream:  [flag:1][crc32:4][body]
 *   flag 0 = body is stored as-is, flag 1 = body is deflate-raw compressed
 *   crc32 is of the uncompressed body
 *   body = [metaLength:2][meta JSON (UTF-8)][content bytes]
 */
(function (root) {
  'use strict';

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function toB64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64url(str) {
    var b = str.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    var bin = atob(b), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function pipe(bytes, stream) {
    var res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await res.arrayBuffer());
  }
  async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try { return await pipe(bytes, new CompressionStream('deflate-raw')); } catch (e) { return null; }
  }
  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unpack compressed data.');
    return pipe(bytes, new DecompressionStream('deflate-raw'));
  }

  function newSession() {
    var s = '';
    var a = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var r = new Uint8Array(4);
    (root.crypto || { getRandomValues: function (x) { for (var i = 0; i < x.length; i++) x[i] = Math.random() * 256; } }).getRandomValues(r);
    for (var i = 0; i < 4; i++) s += a[r[i] % a.length];
    return s;
  }

  /**
   * @param {{kind:'text'|'file', name?:string, type?:string, bytes:Uint8Array}} item
   * @param {{frameChars?:number}} opts  payload characters per frame
   * @returns {Promise<{frames:string[], stats:object}>}
   */
  async function pack(item, opts) {
    var frameChars = (opts && opts.frameChars) || 280;
    var meta = new TextEncoder().encode(JSON.stringify({
      k: item.kind, n: item.name || '', t: item.type || '', s: item.bytes.length
    }));
    var body = new Uint8Array(2 + meta.length + item.bytes.length);
    body[0] = meta.length >> 8; body[1] = meta.length & 0xFF;
    body.set(meta, 2);
    body.set(item.bytes, 2 + meta.length);

    var crc = crc32(body);
    var packed = await deflate(body);
    var flag = 1;
    if (!packed || packed.length >= body.length) { packed = body; flag = 0; }

    var stream = new Uint8Array(5 + packed.length);
    stream[0] = flag;
    stream[1] = crc >>> 24; stream[2] = (crc >>> 16) & 0xFF; stream[3] = (crc >>> 8) & 0xFF; stream[4] = crc & 0xFF;
    stream.set(packed, 5);

    var text = toB64url(stream);
    var total = Math.max(1, Math.ceil(text.length / frameChars));
    if (total > 60000) throw new RangeError('That is too much data. The limit is about 10 MB.');
    var sid = newSession(), frames = [];
    for (var i = 0; i < total; i++) {
      frames.push('QS1.' + sid + '.' + i.toString(36) + '.' + total.toString(36) + '.' +
        text.slice(i * frameChars, (i + 1) * frameChars));
    }
    return {
      frames: frames,
      stats: { originalBytes: item.bytes.length, sentBytes: stream.length, compressed: flag === 1, frames: total }
    };
  }

  root.QREncoder = { pack: pack, crc32: crc32, toB64url: toB64url, fromB64url: fromB64url, inflate: inflate };
})(typeof window !== 'undefined' ? window : globalThis);
