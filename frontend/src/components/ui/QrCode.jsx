import { useEffect, useState } from 'react';

// QR as inline SVG (no images on patient screens). The encoder loads only when needed.
export default function QrCode({ value, label, size = 208 }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let alive = true;
    import('qrcode')
      .then((QR) => QR.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#1B2523', light: '#FFFFFF' } }))
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(''));
    return () => {
      alive = false;
    };
  }, [value]);
  return (
    <div
      role="img"
      aria-label={label}
      style={{ width: size, height: size, margin: '0 auto', background: 'var(--sheet)', borderRadius: 'var(--r-paper)', padding: 8 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
