import { LANGS } from '../../i18n';
import './PrefsSwitches.css';

// Language switch, like the three scripts on a hospital signboard. tone: 'ink' (light bg) | 'sheet' (on green)
export function LanguageSwitch({ value, onChange, label, tone = 'ink', size = 'patient' }) {
  return (
    <div role="radiogroup" aria-label={label} className={`pref-group pref-group--${size}`}>
      {LANGS.map((l) => (
        <button key={l.code} type="button" role="radio" aria-checked={l.code === value} lang={l.code} onClick={() => onChange(l.code)} className={`pref-btn pref-btn--${tone} ${l.code === value ? 'is-active' : ''}`}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

export function TextSizeSwitch({ value, onChange, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="pref-group pref-group--patient">
      {[100, 125, 150].map((v, i) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} aria-label={`${label} ${v}%`} onClick={() => onChange(v)} className={`pref-btn pref-btn--ink font-display ${v === value ? 'is-active' : ''}`} style={{ fontSize: `${0.875 + i * 0.2}rem`, minWidth: 44 }}>
          A
        </button>
      ))}
    </div>
  );
}

export function ContrastToggle({ value, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={value} onClick={() => onChange(!value)} className={`pref-btn pref-btn--ink pref-btn--contrast ${value ? 'is-active-ink' : ''}`}>
      {label}
    </button>
  );
}
