/* script.js — UI wiring for QR-Share */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var COLORS = { track: '#B9C6CC', active: '#1D4BFF', part: '#79C4A6', done: '#0E7A55' };
  var MAX_BYTES = 10 * 1024 * 1024;

  function humanSize(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function humanDuration(sec) {
    if (sec < 90) return Math.max(1, Math.round(sec)) + ' seconds';
    var m = sec / 60;
    if (m < 90) return Math.round(m) + ' minutes';
    return (sec / 3600).toFixed(1) + ' hours';
  }
  function toRanges(nums) {
    var out = [];
    if (!nums.length) return out;
    var s = nums[0], p = nums[0];
    for (var i = 1; i <= nums.length; i++) {
      var v = nums[i];
      if (v === p + 1) { p = v; continue; }
      out.push(s === p ? String(s) : s + '-' + p);
      s = v; p = v;
    }
    return out;
  }

  /* ---------- Segmented ring around the stage ---------- */
  // stateOf(fromFrame, toFrame) -> 'track' | 'active' | 'part' | 'done'
  function drawRing(canvas, total, stateOf) {
    var dpr = window.devicePixelRatio || 1;
    var px = Math.round((canvas.clientWidth || 320) * dpr);
    if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, px, px);
    var lw = Math.max(4, Math.round(px * 0.02));
    var inset = lw / 2 + 1, L = px - inset * 2;
    function pt(t) {
      var u = (t % 1) * 4, side = Math.floor(u), f = u - side;
      if (side === 0) return [inset + f * L, inset];
      if (side === 1) return [inset + L, inset + f * L];
      if (side === 2) return [inset + L - f * L, inset + L];
      return [inset, inset + L - f * L];
    }
    var cells = Math.min(total, 80);
    var gap = cells > 1 ? 0.22 : 0;
    ctx.lineWidth = lw;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    for (var k = 0; k < cells; k++) {
      var from = Math.floor(k * total / cells), to = Math.floor((k + 1) * total / cells);
      var t0 = (k + gap / 2) / cells, t1 = (k + 1 - gap / 2) / cells;
      ctx.strokeStyle = COLORS[stateOf(from, to)];
      ctx.beginPath();
      var pts = [t0];
      for (var c = 1; c < 4; c++) if (c / 4 > t0 && c / 4 < t1) pts.push(c / 4);
      pts.push(t1);
      for (var i = 0; i < pts.length; i++) {
        var p = pt(pts[i] >= 1 ? 0.99999 : pts[i]);
        if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
    }
  }

  /* ---------- Tabs ---------- */
  var tabs = { send: $('#tab-send'), receive: $('#tab-receive') };
  var panels = { send: $('#panel-send'), receive: $('#panel-receive') };

  function showTab(name) {
    Object.keys(tabs).forEach(function (k) {
      var on = k === name;
      tabs[k].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[k].tabIndex = on ? 0 : -1;
      panels[k].hidden = !on;
    });
    if (name !== 'receive') stopCamera();
    if (name === 'receive') resetReceiverView();
    if (name === 'send') redrawSender();
  }
  tabs.send.addEventListener('click', function () { showTab('send'); });
  tabs.receive.addEventListener('click', function () { showTab('receive'); });
  [tabs.send, tabs.receive].forEach(function (t) {
    t.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var next = t === tabs.send ? 'receive' : 'send';
        showTab(next); tabs[next].focus();
      }
    });
  });

  /* ---------- Sender ---------- */
  // S.order is the list of frame indexes being looped (all frames, or just the ones being resent).
  var S = { frames: [], cache: new Map(), version: 1, idx: 0, order: [], pos: 0, raf: 0, playing: false, wake: null, prefetchTimer: 0 };
  var pickedFile = null;

  $('#speed').addEventListener('change', function () {
    $('#speedNote').hidden = parseInt(this.value, 10) < 10;
  });

  $('#pick').addEventListener('click', function () { $('#file').click(); });
  $('#file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    pickedFile = f;
    $('#fileinfo').textContent = f.name + ' (' + humanSize(f.size) + ')';
    $('#fileinfo').hidden = false;
    $('#clearFile').hidden = false;
    $('#text').disabled = true;
    sendError(f.size > MAX_BYTES ? 'That file is ' + humanSize(f.size) + '. The limit is 10 MB.' : '');
  });
  $('#clearFile').addEventListener('click', function () {
    pickedFile = null;
    $('#file').value = '';
    $('#fileinfo').hidden = true;
    $('#clearFile').hidden = true;
    $('#text').disabled = false;
    sendError('');
  });

  function sendError(msg) {
    var el = $('#sendError');
    el.textContent = msg;
    el.hidden = !msg;
  }

  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  $('#make').addEventListener('click', async function () {
    sendError('');
    var btn = $('#make');
    var item;
    if (pickedFile) {
      if (pickedFile.size > MAX_BYTES) { sendError('That file is ' + humanSize(pickedFile.size) + '. The limit is 10 MB.'); return; }
    } else if (!$('#text').value) {
      sendError('Type some text or choose a file first.'); return;
    }

    btn.disabled = true;
    btn.textContent = 'Preparing';
    await tick();
    try {
      if (pickedFile) {
        item = { kind: 'file', name: pickedFile.name, type: pickedFile.type, bytes: new Uint8Array(await pickedFile.arrayBuffer()) };
      } else {
        item = { kind: 'text', bytes: new TextEncoder().encode($('#text').value) };
      }
      var result = await QREncoder.pack(item, { frameChars: parseInt($('#size').value, 10) });

      S.frames = result.frames;
      S.cache = new Map();
      var longest = S.frames.reduce(function (a, b) { return b.length > a.length ? b : a; });
      S.version = QRGen.encode(longest, 'M').version;

      var st = result.stats;
      var fps = parseInt($('#speed').value, 10);
      $('#sendStats').textContent = st.frames === 1
        ? 'This fits in a single code (' + humanSize(st.sentBytes) + ').'
        : st.frames + ' frames, ' + humanSize(st.sentBytes) + ' to send' +
          (st.compressed ? ' after compressing ' + humanSize(st.originalBytes) : '') +
          '. One full loop takes about ' + humanDuration(st.frames / fps) + '.';

      // Small jobs are fully built up front; big ones start after a short head start and stay ahead of playback.
      var pre = Math.min(S.frames.length, 300);
      for (var i = 0; i < pre; i++) {
        getQR(i);
        if (i % 8 === 7) await tick();
      }
    } catch (err) {
      sendError(err.message || 'Something went wrong while preparing the data.');
      btn.disabled = false;
      btn.textContent = 'Make QR stream';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Make QR stream';

    S.order = S.frames.map(function (_, i) { return i; });
    S.pos = 0;
    var multi = S.frames.length > 1;
    $('#compose').hidden = true;
    $('#player').hidden = false;
    $('#player .controls').hidden = !multi;
    $('#resend').hidden = !multi;
    $('#resend').open = false;
    $('#resendList').value = '';
    $('#resendError').hidden = true;
    $('#sendHint').textContent = multi
      ? 'Hold the other phone steady until its ring is full and green.'
      : 'Point the other phone at this code.';
    showFrame(0);
    if (multi) play();
    requestWake();
  });

  function getQR(i) {
    var q = S.cache.get(i);
    if (!q) {
      q = QRGen.encode(S.frames[i], 'M', S.version, S.version);
      S.cache.set(i, q);
      if (S.cache.size > 700) {
        var it = S.cache.keys();
        while (S.cache.size > 500) S.cache.delete(it.next().value);
      }
    }
    return q;
  }

  // Keep upcoming frames ready so playback never waits on the encoder.
  function prefetch() {
    clearTimeout(S.prefetchTimer);
    var L = S.order.length;
    if (L < 2 || $('#player').hidden) return;
    var ahead = Math.min(L, 150);
    for (var k = 1; k <= ahead; k++) {
      var f = S.order[(S.pos + k) % L];
      if (!S.cache.has(f)) {
        getQR(f);
        S.prefetchTimer = setTimeout(prefetch, 0);
        return;
      }
    }
  }

  function showFrame(f) {
    S.idx = f;
    QRGen.draw($('#qr'), getQR(f), 4, 720);
    var n = S.frames.length;
    $('#frameLabel').textContent = n === 1 ? 'Ready to scan'
      : S.order.length < n
        ? 'Frame ' + (f + 1) + ' of ' + n + ', looping ' + S.order.length + ' frames'
        : 'Frame ' + (f + 1) + ' of ' + n;
    drawRing($('#sendRing'), n, function (from, to) {
      return S.idx >= from && S.idx < to ? 'active' : 'track';
    });
    setTimeout(prefetch, 0);
  }

  function step(d) {
    var L = S.order.length;
    S.pos = (S.pos + d + L) % L;
    showFrame(S.order[S.pos]);
  }

  function redrawSender() { if (S.frames.length && !$('#player').hidden) showFrame(S.idx); }

  function play() {
    pause();
    S.playing = true;
    $('#play').textContent = 'Pause';
    var interval = 1000 / parseInt($('#speed').value, 10);
    var next = performance.now() + interval;
    (function loop(now) {
      if (!S.playing) return;
      if (now >= next - 2) {
        step(1);
        next += interval;
        if (next < now) next = now + interval; // fell behind: resync instead of bursting
      }
      S.raf = requestAnimationFrame(loop);
    })(performance.now());
  }
  function pause() {
    S.playing = false;
    cancelAnimationFrame(S.raf);
    S.raf = 0;
    $('#play').textContent = 'Play';
  }
  $('#play').addEventListener('click', function () { S.playing ? pause() : play(); });
  $('#prev').addEventListener('click', function () { pause(); step(-1); });
  $('#next').addEventListener('click', function () { pause(); step(1); });
  $('#edit').addEventListener('click', function () {
    pause();
    releaseWake();
    clearTimeout(S.prefetchTimer);
    S.frames = []; S.cache = new Map(); S.order = [];
    $('#player').hidden = true;
    $('#compose').hidden = false;
  });

  // Resend list: "12, 40-55, 300" (frame numbers as shown on the receiver)
  function parseFrameList(text, n) {
    var set = {}, tokens = text.split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) throw new Error('Enter at least one frame number.');
    tokens.forEach(function (t) {
      var m = /^(\d+)(?:[-\u2013](\d+))?$/.exec(t);
      if (!m) throw new Error('"' + t + '" is not a frame number or range.');
      var a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || b > n || a > b) throw new Error('Frames must be between 1 and ' + n + '.');
      for (var i = a; i <= b; i++) set[i - 1] = true;
    });
    return Object.keys(set).map(Number).sort(function (x, y) { return x - y; });
  }
  $('#resendGo').addEventListener('click', function () {
    try {
      S.order = parseFrameList($('#resendList').value, S.frames.length);
    } catch (err) {
      $('#resendError').textContent = err.message;
      $('#resendError').hidden = false;
      return;
    }
    $('#resendError').hidden = true;
    S.pos = 0;
    showFrame(S.order[0]);
    play();
  });
  $('#resendAll').addEventListener('click', function () {
    var cur = S.idx;
    S.order = S.frames.map(function (_, i) { return i; });
    S.pos = cur;
    $('#resendError').hidden = true;
    $('#resendList').value = '';
    showFrame(cur);
    play();
  });

  function requestWake() {
    try {
      if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { S.wake = w; }).catch(function () {});
    } catch (e) { /* optional */ }
  }
  function releaseWake() {
    try { if (S.wake) S.wake.release(); } catch (e) { /* optional */ }
    S.wake = null;
  }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && S.frames.length && !$('#player').hidden) requestWake();
  });

  /* ---------- Receiver ---------- */
  var asm = new QRDecoder.Assembler();
  var scanner = null;
  var lastIgnoredAt = 0;
  var downloadUrl = null;
  var missingText = '';

  function resetReceiverView() {
    if (scanner) return; // camera running; leave as is
    $('#recvLive').hidden = true;
    if (!$('#result').hidden) return;
    $('#recvIdle').hidden = false;
  }

  function recvError(msg) {
    var el = $('#recvError');
    el.textContent = msg;
    el.hidden = !msg;
  }

  $('#startCam').addEventListener('click', startCamera);
  $('#stopCam').addEventListener('click', function () {
    stopCamera();
    $('#recvLive').hidden = true;
    $('#recvIdle').hidden = false;
  });
  $('#again').addEventListener('click', function () {
    clearResult();
    asm.reset();
    startCamera();
  });
  $('#copyMissing').addEventListener('click', function () {
    var btn = this, old = btn.textContent;
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = old; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(missingText).then(done, function () {});
  });

  // Starting the camera again keeps any frames already collected for the current transfer.
  async function startCamera() {
    recvError('');
    clearResult();
    $('#recvIdle').hidden = true;
    $('#recvLive').hidden = false;
    $('#recvStatus').textContent = asm.total ? 'Scanning' : 'Looking for a QR-Share code';
    drawRing($('#recvRing'), asm.total || 1, ringState);
    if (asm.total) updateReceiver(); else $('#recvMissing').textContent = '';

    scanner = new QRScanner.Scanner($('#cam'), onScan);
    try {
      await scanner.start();
    } catch (err) {
      scanner = null;
      $('#recvLive').hidden = true;
      $('#recvIdle').hidden = false;
      if (err.code === 'no-decoder') {
        recvError('This browser cannot read QR codes from the camera yet. Add lib/jsQR.js (see the README), or use Chrome on Android.');
      } else if (err.code === 'no-camera-api') {
        recvError('The camera needs a secure page. Open this app from https, localhost, or install it from your home screen.');
      } else if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        recvError('Camera access is blocked. Allow the camera for this page, then tap Start camera again.');
      } else if (err.name === 'NotFoundError') {
        recvError('No camera was found on this device.');
      } else {
        recvError('The camera could not start: ' + (err.message || err.name));
      }
    }
  }

  function stopCamera() {
    if (scanner) { scanner.stop(); scanner = null; }
  }

  function onScan(text) {
    var r = asm.accept(text);
    if (r.status === 'ignored') {
      var now = Date.now();
      if (now - lastIgnoredAt > 2500) {
        lastIgnoredAt = now;
        $('#recvStatus').textContent = 'That QR code is not QR-Share data';
      }
      return;
    }
    if (r.status === 'duplicate') return;
    if (asm.count % 25 === 1 && navigator.vibrate) navigator.vibrate(10);
    updateReceiver();
    if (asm.isComplete()) finishReceive();
  }

  function ringState(from, to) {
    var got = 0;
    for (var i = from; i < to; i++) if (asm.has(i)) got++;
    return got === to - from ? 'done' : got > 0 ? 'part' : 'track';
  }

  function updateReceiver() {
    drawRing($('#recvRing'), asm.total, ringState);
    var pct = Math.floor(asm.count * 100 / asm.total);
    $('#recvStatus').textContent = asm.total === 1
      ? 'Reading code'
      : asm.count + ' of ' + asm.total + ' frames (' + pct + '%)';
    if (asm.count > 0 && asm.count < asm.total) {
      var ranges = toRanges(asm.missing());
      missingText = ranges.join(', ');
      $('#recvMissing').textContent = 'Still needed: ' + ranges.slice(0, 6).join(', ') +
        (ranges.length > 6 ? ' and ' + (ranges.length - 6) + ' more groups' : '') + '.';
      $('#copyMissing').hidden = ranges.length <= 6;
    } else {
      $('#recvMissing').textContent = '';
      $('#copyMissing').hidden = true;
    }
  }

  async function finishReceive() {
    stopCamera();
    $('#recvStatus').textContent = 'Unpacking';
    var res;
    try {
      res = await asm.finish();
    } catch (err) {
      $('#recvLive').hidden = true;
      $('#recvIdle').hidden = false;
      recvError(err.message);
      asm.reset();
      return;
    }
    asm.reset();
    showResult(res);
  }

  function clearResult() {
    $('#result').hidden = true;
    $('#resultBody').textContent = '';
    if (downloadUrl) { URL.revokeObjectURL(downloadUrl); downloadUrl = null; }
  }

  function showResult(res) {
    $('#recvLive').hidden = true;
    $('#recvIdle').hidden = true;
    var body = $('#resultBody'), action = $('#resultAction');
    body.textContent = '';
    action.onclick = null;

    if (res.kind === 'text') {
      $('#resultTitle').textContent = 'Text received';
      var ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.value = res.text;
      ta.rows = 8;
      ta.setAttribute('aria-label', 'Received text');
      body.appendChild(ta);
      action.textContent = 'Copy text';
      action.onclick = function () { copyText(res.text, ta, action); };
    } else {
      $('#resultTitle').textContent = 'File received';
      var line = document.createElement('p');
      line.className = 'fileline';
      line.textContent = (res.name || 'file') + ' (' + humanSize(res.bytes.length) + ')';
      body.appendChild(line);
      var blob = new Blob([res.bytes], { type: res.type || 'application/octet-stream' });
      downloadUrl = URL.createObjectURL(blob);
      if (/^image\//.test(res.type)) {
        var img = document.createElement('img');
        img.src = downloadUrl;
        img.alt = res.name || 'Received image';
        body.appendChild(img);
      }
      action.textContent = 'Save file';
      action.onclick = function () {
        var a = document.createElement('a');
        a.href = downloadUrl;
        a.download = res.name || 'qr-share-file';
        document.body.appendChild(a);
        a.click();
        a.remove();
      };
    }
    $('#result').hidden = false;
  }

  function copyText(text, ta, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = old; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      ta.focus(); ta.select();
      try { if (document.execCommand('copy')) done(); } catch (e) { /* user can copy manually */ }
    }
  }

  window.addEventListener('resize', function () {
    redrawSender();
    if (scanner && asm.total) updateReceiver();
  });

  /* ---------- Offline support ---------- */
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* optional */ });
  }
})();
