/*
 * qr-scanner.js
 * Reads QR codes from the camera.
 *  1. Uses the browser's built-in BarcodeDetector when it exists (Chrome/Edge on Android, ChromeOS, macOS).
 *  2. Otherwise uses jsQR if lib/jsQR.js has been added (see README) — this covers iPhone Safari and desktop Windows/Linux.
 */
(function (root) {
  'use strict';

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('missing ' + src)); };
      document.head.appendChild(s);
    });
  }

  function Scanner(video, onText) {
    this.video = video;
    this.onText = onText;
    this.stream = null;
    this.running = false;
    this.detect = null;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  Scanner.prototype._prepareDecoder = async function () {
    if (this.detect) return;
    if ('BarcodeDetector' in root) {
      try {
        var formats = await root.BarcodeDetector.getSupportedFormats();
        if (formats.indexOf('qr_code') !== -1) {
          var bd = new root.BarcodeDetector({ formats: ['qr_code'] });
          var video = this.video;
          this.detect = async function () {
            var found = await bd.detect(video);
            return found.length ? found[0].rawValue : null;
          };
          return;
        }
      } catch (e) { /* fall through to jsQR */ }
    }
    if (!root.jsQR) {
      try { await loadScript('lib/jsQR.js'); } catch (e) { /* handled below */ }
    }
    if (root.jsQR) {
      var self = this;
      this.detect = async function () {
        var v = self.video;
        if (!v.videoWidth) return null;
        var scale = Math.min(1, 720 / v.videoWidth);
        var w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
        self.canvas.width = w; self.canvas.height = h;
        self.ctx.drawImage(v, 0, 0, w, h);
        var img = self.ctx.getImageData(0, 0, w, h);
        var code = root.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        return code ? code.data : null;
      };
      return;
    }
    var err = new Error('no-decoder');
    err.code = 'no-decoder';
    throw err;
  };

  Scanner.prototype.start = async function () {
    await this._prepareDecoder();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      var e = new Error('no-camera-api');
      e.code = 'no-camera-api';
      throw e;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    this.running = true;
    this._loop();
  };

  Scanner.prototype._loop = function () {
    var self = this, busy = false;
    function onFrame() {
      if (!self.running) return;
      if (!busy && self.video.readyState >= 2) {
        busy = true;
        Promise.resolve(self.detect()).then(function (text) {
          if (text && self.running) self.onText(text);
        }).catch(function () { /* a failed frame is fine */ }).then(function () { busy = false; });
      }
      schedule();
    }
    function schedule() {
      if (self.video.requestVideoFrameCallback) self.video.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(onFrame);
    }
    schedule();
  };

  Scanner.prototype.stop = function () {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
    this.stream = null;
    this.video.srcObject = null;
  };

  root.QRScanner = { Scanner: Scanner };
})(typeof window !== 'undefined' ? window : globalThis);
