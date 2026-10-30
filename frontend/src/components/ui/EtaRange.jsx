import { formatRange } from '../../utils/format';

// Formats [from, to] in the user's locale. Never a single time.
export default function EtaRange({ range, lng, className = '' }) {
  return (
    <time className={`tnum ${className}`} dateTime={`${range[0]}/${range[1]}`}>
      {formatRange(range, lng)}
    </time>
  );
}
