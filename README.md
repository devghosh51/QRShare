# QR-Share

Send text and small files between two phones using only a screen and a camera.
No internet, Wi-Fi, Bluetooth or server is involved. Everything runs in the browser.

## How it works
1. **Sender** types text or picks a file. The app compresses it and splits it into numbered frames.
2. Each frame is shown as a QR code, looping. A ring around the code shows which frame is on screen.
3. **Receiver** points its camera at the screen. Frames can be caught in any order. Each captured segment of the ring turns green.
4. When every frame is in, the app checks a CRC and shows the text or offers the file to save.

Playback speed is adjustable from 2 to 20 frames per second. Throughput is frames per second times frame size, so Large frames at 20 per second can reach several KB per second when the camera catches every frame. In practice, 5 to 10 per second is the reliable range; 15 to 20 needs a bright screen, good light, a steady hand and a phone with a fast camera. Missed frames are simply picked up on the next loop.

## Files
| File | Job |
| --- | --- |
| index.html, style.css, script.js | Interface and app logic |
| qr-generator.js | QR encoder (versions 1 to 40), no dependencies |
| encoder.js / decoder.js | Packing, compression, framing, CRC check, reassembly |
| qr-scanner.js | Camera scanning |
| manifest.json, sw.js, icons/ | Install-to-home-screen and offline cache |
| lib/ | Optional place for jsQR.js (see below) |

## Running it
Open `index.html` directly in Chrome for a quick try, or host the folder once and install it:

    cd QR-Share
    python3 -m http.server 8000      # then open http://<your-computer-ip>:8000 on the phone

After the first visit the service worker caches everything, so "Add to Home screen" gives you an app that works fully offline.
Camera access needs https or localhost, or a file opened from local storage in Chrome.

## Scanning support (important)
- **Chrome / Edge on Android, ChromeOS, macOS:** scanning works with the browser's built-in BarcodeDetector.
- **iPhone Safari, Windows/Linux desktop:** no built-in detector. Download `jsQR.js` (the dist build from github.com/cozmo/jsQR) once and save it as `lib/jsQR.js`. The app loads it automatically and the service worker caches it.
- Showing codes works in every modern browser.

## Tips
- Raise screen brightness on the sender and keep both phones still.
- If frames are missed, lower the speed first, then choose "Small" frame size.
- The receiver lists which frames are still needed. Just keep pointing at the screen until they come round again.
- For big files, one pass rarely catches every frame. On the sender open "Resend missing frames", type the list shown on the receiver (for example 12, 40-55, 300) and only those frames will loop. The receiver keeps what it already has, even if you stop and restart the camera.
- Very fast speeds depend on the phone cameras. If many frames are missed, drop to 10 per second or use smaller frames.

## Tested
- Encoder checked against OpenCV's QR decoder across versions 1 to 39 and all four error-correction levels.
- Pack and unpack round trip for text, unicode and binary data, shuffled and duplicated frames, damaged-frame detection.
- A 10 MB random file packs and unpacks intact, including resending dropped frames. The sender really runs at 20 frames per second in a browser.
- Camera scanning was not tested on a physical phone, so real-world speeds will vary.
