/*
 * qr-generator.js
 * Dependency-free QR Code encoder (byte mode, versions 1-40, ECC L/M/Q/H).
 * Exposes: QRGen.encode(textOrBytes, ecl, minVersion, maxVersion) -> { size, version, get(x, y) }
 *          QRGen.draw(canvas, qr, quietModules)
 */
(function (root) {
  'use strict';

  // Index = error-correction level ordinal (L, M, Q, H); inner index = version (0 unused).
  var ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  var ECL = { L: { ord: 0, fmt: 1 }, M: { ord: 1, fmt: 0 }, Q: { ord: 2, fmt: 3 }, H: { ord: 3, fmt: 2 } };

  function appendBits(bb, val, len) {
    for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
  }

  function numRawDataModules(ver) {
    var r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }

  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl.ord][ver] * NUM_BLOCKS[ecl.ord][ver];
  }

  function alignPositions(ver) {
    if (ver === 1) return [];
    var n = Math.floor(ver / 7) + 2;
    var size = ver * 4 + 17;
    var step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    var res = [6];
    for (var pos = size - 7; res.length < n; pos -= step) res.splice(1, 0, pos);
    return res;
  }

  // ---- Reed-Solomon over GF(256), polynomial 0x11D ----
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsDivisor(degree) {
    var res = [];
    for (var i = 0; i < degree - 1; i++) res.push(0);
    res.push(1);
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gfMul(res[j], root);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return res;
  }
  function rsRemainder(data, divisor) {
    var res = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var factor = b ^ res.shift();
      res.push(0);
      divisor.forEach(function (coef, i) { res[i] ^= gfMul(coef, factor); });
    });
    return res;
  }

  function addEccAndInterleave(data, ver, ecl) {
    var nBlocks = NUM_BLOCKS[ecl.ord][ver];
    var blockEcc = ECC_PER_BLOCK[ecl.ord][ver];
    var raw = Math.floor(numRawDataModules(ver) / 8);
    var nShort = nBlocks - (raw % nBlocks);
    var shortLen = Math.floor(raw / nBlocks);
    var blocks = [];
    var div = rsDivisor(blockEcc);
    for (var i = 0, k = 0; i < nBlocks; i++) {
      var datLen = shortLen - blockEcc + (i < nShort ? 0 : 1);
      var dat = data.slice(k, k + datLen);
      k += datLen;
      var ecc = rsRemainder(dat, div);
      if (i < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var out = [];
    for (var c = 0; c < blocks[0].length; c++) {
      for (var b = 0; b < blocks.length; b++) {
        if (c !== shortLen - blockEcc || b >= nShort) out.push(blocks[b][c]);
      }
    }
    return out;
  }

  // ---- Matrix construction ----
  function build(ver, ecl, dataCodewords) {
    var size = ver * 4 + 17;
    var modules = [], isFn = [];
    for (var r = 0; r < size; r++) {
      modules.push(new Array(size).fill(false));
      isFn.push(new Array(size).fill(false));
    }
    function setFn(x, y, dark) { modules[y][x] = dark; isFn[y][x] = true; }
    function bit(v, i) { return ((v >>> i) & 1) !== 0; }

    function drawFormat(mask) {
      var data = (ecl.fmt << 3) | mask;
      var rem = data;
      for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      var j;
      for (j = 0; j <= 5; j++) setFn(8, j, bit(bits, j));
      setFn(8, 7, bit(bits, 6));
      setFn(8, 8, bit(bits, 7));
      setFn(7, 8, bit(bits, 8));
      for (j = 9; j < 15; j++) setFn(14 - j, 8, bit(bits, j));
      for (j = 0; j < 8; j++) setFn(size - 1 - j, 8, bit(bits, j));
      for (j = 8; j < 15; j++) setFn(8, size - 15 + j, bit(bits, j));
      setFn(8, size - 8, true);
    }
    function drawVersion() {
      if (ver < 7) return;
      var rem = ver;
      for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bits = (ver << 12) | rem;
      for (var k = 0; k < 18; k++) {
        var b = bit(bits, k), a = size - 11 + (k % 3), c = Math.floor(k / 3);
        setFn(a, c, b);
        setFn(c, a, b);
      }
    }
    function drawFinder(cx, cy) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var xx = cx + dx, yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
          var d = Math.max(Math.abs(dx), Math.abs(dy));
          setFn(xx, yy, d !== 2 && d !== 4);
        }
      }
    }
    function drawAlign(cx, cy) {
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) {
        setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }

    // Function patterns
    for (var i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    drawFinder(3, 3); drawFinder(size - 4, 3); drawFinder(3, size - 4);
    var pos = alignPositions(ver), n = pos.length;
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
      if (!((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0))) drawAlign(pos[a], pos[b]);
    }
    drawFormat(0);
    drawVersion();

    // Codewords
    var codewords = addEccAndInterleave(dataCodewords, ver, ecl);
    var idx = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var upward = ((right + 1) & 2) === 0;
          var y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && idx < codewords.length * 8) {
            modules[y][x] = ((codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
            idx++;
          }
        }
      }
    }

    function applyMask(mask) {
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
        var inv;
        switch (mask) {
          case 0: inv = (x + y) % 2 === 0; break;
          case 1: inv = y % 2 === 0; break;
          case 2: inv = x % 3 === 0; break;
          case 3: inv = (x + y) % 3 === 0; break;
          case 4: inv = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: inv = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: inv = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: inv = ((x + y) % 2 + (x * y) % 3) % 2 === 0;
        }
        if (!isFn[y][x] && inv) modules[y][x] = !modules[y][x];
      }
    }

    function penalty() {
      var res = 0, x, y, run, color;
      var P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      function scan(get) {
        for (var u = 0; u < size; u++) {
          color = false; run = 0;
          for (var v = 0; v < size; v++) {
            var m = get(u, v);
            if (m === color) { run++; if (run === 5) res += 3; else if (run > 5) res++; }
            else { color = m; run = 1; }
          }
          for (var s = 0; s + 11 <= size; s++) {
            var f1 = true, f2 = true;
            for (var t = 0; t < 11 && (f1 || f2); t++) {
              var bv = get(u, s + t) ? 1 : 0;
              if (bv !== P1[t]) f1 = false;
              if (bv !== P2[t]) f2 = false;
            }
            if (f1 || f2) res += 40;
          }
        }
      }
      scan(function (u, v) { return modules[u][v]; });
      scan(function (u, v) { return modules[v][u]; });
      var dark = 0;
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          var c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) res += 3;
        }
      }
      var total = size * size;
      res += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return res;
    }

    var best = 0, bestScore = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      var sc = penalty();
      if (sc < bestScore) { bestScore = sc; best = m; }
      applyMask(m); // undo
    }
    applyMask(best);
    drawFormat(best);

    var flat = new Uint8Array(size * size);
    for (var yy = 0; yy < size; yy++) for (var xx = 0; xx < size; xx++) flat[yy * size + xx] = modules[yy][xx] ? 1 : 0;
    return makeResult(size, ver, best, flat);
  }

  function makeResult(size, ver, mask, flat) {
    return {
      size: size,
      version: ver,
      mask: mask,
      get: function (x, y) { return x >= 0 && x < size && y >= 0 && y < size && flat[y * size + x] === 1; }
    };
  }

  function encode(input, eclName, minVersion, maxVersion) {
    var ecl = ECL[eclName || 'M'];
    var data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    var lo = minVersion || 1, hi = maxVersion || 40, ver;
    for (ver = lo; ; ver++) {
      if (ver > hi) throw new RangeError('Data is too long for one QR code');
      if (4 + (ver <= 9 ? 8 : 16) + data.length * 8 <= numDataCodewords(ver, ecl) * 8) break;
    }
    var cap = numDataCodewords(ver, ecl) * 8;
    var bb = [];
    appendBits(bb, 0x4, 4);
    appendBits(bb, data.length, ver <= 9 ? 8 : 16);
    for (var i = 0; i < data.length; i++) appendBits(bb, data[i], 8);
    appendBits(bb, 0, Math.min(4, cap - bb.length));
    appendBits(bb, 0, (8 - (bb.length % 8)) % 8);
    for (var pad = 0xEC; bb.length < cap; pad ^= 0xEC ^ 0x11) appendBits(bb, pad, 8);
    var cw = [];
    for (var k = 0; k < bb.length; k += 8) {
      var v = 0;
      for (var q = 0; q < 8; q++) v = (v << 1) | bb[k + q];
      cw.push(v);
    }
    return build(ver, ecl, cw);
  }

  // Paint a QR onto a canvas using whole-pixel modules so edges stay sharp.
  function draw(canvas, qr, quiet, targetPx) {
    quiet = quiet == null ? 4 : quiet;
    var n = qr.size + quiet * 2;
    var scale = Math.max(2, Math.floor((targetPx || 640) / n));
    canvas.width = canvas.height = n * scale;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (var y = 0; y < qr.size; y++) for (var x = 0; x < qr.size; x++) {
      if (qr.get(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }

  root.QRGen = { encode: encode, draw: draw };
})(typeof window !== 'undefined' ? window : globalThis);
