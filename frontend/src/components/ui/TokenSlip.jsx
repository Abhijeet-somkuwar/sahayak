import './TokenSlip.css';

/**
 * The OPD slip: the hero of the patient experience. Perforated top edge, the only element with a shadow.
 * variant: 'full' | 'mini' | 'print'
 */
export default function TokenSlip({ variant = 'full', facility, department, numeral, stamp, children, footer, className = '' }) {
  if (variant === 'mini') {
    return (
      <div className={`slip slip--mini ${className}`}>
        {department && <p className="text-sm text-soft">{department}</p>}
        {children}
      </div>
    );
  }
  return (
    <article className={`slip slip--full ${variant === 'print' ? 'print-slip' : ''} ${className}`}>
      <header className="slip__header">
        {facility && <p className="text-md text-soft">{facility}</p>}
        {department && <h1 className="slip__department">{department}</h1>}
      </header>
      <div className="slip__numeral">
        {numeral}
        {stamp && <div className="slip__stamp">{stamp}</div>}
      </div>
      {children && <div className="slip__section slip__tear">{children}</div>}
      {footer && <footer className="slip__footer slip__tear">{footer}</footer>}
    </article>
  );
}
