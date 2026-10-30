// Token numeral in Anek, always Latin digits. Read aloud as "Token M E D 047".
// surface: 'slip' (width 75) | 'board' (width 100) | 'inline' | 'mini'
export default function TokenNumeral({ prefix, number, surface = 'slip', muted = false, className = '' }) {
  const numStr = number == null ? '' : typeof number === 'number' ? String(number).padStart(3, '0') : String(number);
  const label = `Token ${prefix.split('').join(' ')} ${numStr}`;

  if (surface === 'inline' || surface === 'mini') {
    return (
      <span role="img" aria-label={label} className={`numeral tnum token-numeral--${surface} ${className}`}>
        {prefix}-{numStr}
      </span>
    );
  }
  if (surface === 'board') {
    return (
      <span role="img" aria-label={label} className={`numeral numeral--board tnum token-numeral--board ${className}`}>
        {prefix}-{numStr}
      </span>
    );
  }
  return (
    <div role="img" aria-label={label} className={`token-numeral ${className}`}>
      <span className="numeral token-numeral__prefix" aria-hidden>
        {prefix}
      </span>
      <span className={`numeral token-numeral__number ${!numStr && muted ? 'token-numeral__number--hidden' : ''}`} aria-hidden>
        {numStr || '000'}
      </span>
    </div>
  );
}
