import { useEffect } from 'react';
import { CheckOutlined } from '@ant-design/icons';
import { vibrate } from '../../utils/audio';

// Violet confirmation stamp with localized text ("Checked in" / "पंजीकृत" / "નોંધાયેલ").
export default function Stamp({ text, size = 'md', haptic = true }) {
  useEffect(() => {
    if (haptic) vibrate(30);
  }, [haptic]);
  return (
    <span className={`stamp ${size === 'sm' ? 'stamp--sm' : ''}`} role="img" aria-label={text}>
      <span className="stamp__inner" aria-hidden>
        <CheckOutlined style={{ fontSize: size === 'sm' ? 16 : 22 }} />
        <span>{text}</span>
      </span>
    </span>
  );
}
