import { useEffect, useRef } from 'react';

// Single-key shortcuts. Disabled while typing in a field unless a shortcut is marked `global`.
export function useKeyboardShortcuts(shortcuts, enabled = true) {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      for (const s of ref.current) {
        if (e.key.toLowerCase() !== s.key.toLowerCase()) continue;
        if (typing && !s.global) continue;
        e.preventDefault();
        s.handler();
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
