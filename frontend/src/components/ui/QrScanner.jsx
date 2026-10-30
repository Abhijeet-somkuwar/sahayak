import { useEffect, useRef, useState } from 'react';

// Kiosk QR scanning with the BarcodeDetector API. Calls onUnavailable when there is no camera/API,
// so the kiosk can offer the phone-number and slip-code paths instead.
export default function QrScanner({ onResult, onUnavailable, className = '' }) {
  const video = useRef(null);
  const [active, setActive] = useState(false);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  useEffect(() => {
    const Detector = window.BarcodeDetector;
    if (!Detector || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      unavailableRef.current();
      return undefined;
    }
    let stream = null;
    let timer = 0;
    let stopped = false;
    const detector = new Detector({ formats: ['qr_code'] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
        if (stopped || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        setActive(true);
        const tick = async () => {
          if (stopped || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes[0] && codes[0].rawValue) {
              resultRef.current(codes[0].rawValue);
              return;
            }
          } catch {
            /* frame not ready */
          }
          timer = setTimeout(tick, 250);
        };
        tick();
      } catch {
        unavailableRef.current();
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className={className}>
      <video ref={video} muted playsInline aria-hidden={!active} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--r-paper)', background: 'var(--ward-deep)' }} />
    </div>
  );
}
