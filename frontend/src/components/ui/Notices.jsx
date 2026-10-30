import { DisconnectOutlined, HistoryOutlined } from '@ant-design/icons';
import './Notices.css';

// Inline result under a form or action. tone: success | error | info
export function InlineNotice({ tone = 'info', children, className = '' }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`notice notice--${tone} fade-in ${className}`}>
      {children}
    </div>
  );
}

// Quiet banner for kiosk/counter when the network is down.
export function OfflineBanner({ text }) {
  return (
    <div role="status" className="offline-banner">
      <DisconnectOutlined aria-hidden /> {text}
    </div>
  );
}

// "Updated 20 seconds ago" line under the slip, or "Last updated 10:41" on the board.
export function StaleIndicator({ text, tone = 'ink' }) {
  return (
    <p role="status" className={`stale stale--${tone}`}>
      <HistoryOutlined aria-hidden /> {text}
    </p>
  );
}

// Progress from check-in to the expected time. Static fill, no shimmer.
export function ProgressBar({ value, label }) {
  const v = Math.max(0, Math.min(100, Math.round(value || 0)));
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-label={label} className="progress">
      <div className="progress__fill" style={{ width: `${v}%` }} />
    </div>
  );
}
