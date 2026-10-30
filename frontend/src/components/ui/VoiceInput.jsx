import { useEffect, useRef, useState } from 'react';
import { Button } from 'antd';
import { AudioOutlined, StopOutlined } from '@ant-design/icons';

// Records a voice note with MediaRecorder; falls back to text when the microphone is unavailable.
export default function VoiceInput({ onRecorded, labels }) {
  const [state, setState] = useState('idle'); // idle | recording | denied
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef(null);
  const chunks = useRef([]);

  useEffect(() => {
    if (state !== 'recording') return undefined;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [state]);

  const start = async () => {
    if (!navigator.mediaDevices || typeof MediaRecorder === 'undefined') return setState('denied');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        onRecorded(new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }));
      };
      r.start();
      recorder.current = r;
      setSeconds(0);
      setState('recording');
    } catch {
      setState('denied');
    }
    return undefined;
  };
  const stop = () => {
    if (recorder.current) recorder.current.stop();
    recorder.current = null;
    setState('idle');
  };

  if (state === 'denied') return <p className="text-soft">{labels.denied}</p>;
  if (state === 'recording')
    return (
      <Button size="large" icon={<StopOutlined style={{ color: 'var(--triage-emergency)' }} />} onClick={stop} aria-live="polite">
        {labels.stop} · {labels.recording(seconds)}
      </Button>
    );
  return (
    <Button size="large" icon={<AudioOutlined />} onClick={start}>
      {labels.record}
    </Button>
  );
}
