import { ArrowUpOutlined, SafetyOutlined } from '@ant-design/icons';
import './LaneRail.css';

const LANES = ['urgent', 'protected', 'general'];
const ICONS = { urgent: ArrowUpOutlined, protected: SafetyOutlined, general: null };

/**
 * Doctor queue column grouped by lane (§4.5). `tokens` are the next waiting codes per lane;
 * `counts` ({ urgent, protected, general }) are the live lane totals from the queue snapshot.
 * A region of the screen: no cards, hairlines only.
 */
export default function LaneRail({ tokens, counts, labels, selectedId, onSelect, footer }) {
  return (
    <nav aria-label="Queue" className="lane-rail">
      <div className="lane-rail__scroll">
        {LANES.map((lane) => {
          const rows = tokens.filter((t) => t.lane === lane);
          const Icon = ICONS[lane];
          const total = counts && counts[lane] != null ? counts[lane] : rows.length;
          return (
            <section key={lane} aria-label={labels[lane]}>
              <h3 className="lane-rail__head">
                <span className="row">
                  {Icon && <Icon aria-hidden className="text-soft" />}
                  {labels[lane]}
                </span>
                <span className="tnum text-soft">{total}</span>
              </h3>
              <ul>
                {rows.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => onSelect && onSelect(t)} aria-current={selectedId === t.id ? 'true' : undefined} className={`lane-rail__row ${selectedId === t.id ? 'is-selected' : ''} ${t.status === 'called' ? 'is-called' : ''}`}>
                      <span className="numeral tnum">{t.code}</span>
                      <span className="row text-soft">
                        {t.callCount > 0 && <span aria-label={`called ${t.callCount} times`}>×{t.callCount}</span>}
                        {t.lane === 'urgent' && <ArrowUpOutlined aria-hidden style={{ color: 'var(--triage-priority)' }} />}
                      </span>
                    </button>
                  </li>
                ))}
                {rows.length === 0 && <li className="lane-rail__empty">—</li>}
                {total > rows.length && <li className="lane-rail__empty tnum">+{total - rows.length}</li>}
              </ul>
            </section>
          );
        })}
      </div>
      {footer && <div className="lane-rail__footer">{footer}</div>}
    </nav>
  );
}
