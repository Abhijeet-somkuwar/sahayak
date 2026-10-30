// Two-tone chime for "now calling" and a sharper alert for casualty; silently does nothing if blocked.
export function playChime(kind = 'call') {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const notes = kind === 'call' ? [880, 1174] : [660, 440, 660];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g).connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
      o.start(t);
      o.stop(t + 0.18);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {
    /* ignore */
  }
}

export function vibrate(ms) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    /* ignore */
  }
}
