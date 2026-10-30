import { Checkbox, Radio } from 'antd';
import './AnswerOptions.css';

/**
 * Large answer list for intake: full-width rows, 56px+, left aligned.
 * mode 'single' uses radios (arrow keys move between them), 'multi' uses checkboxes.
 */
export default function AnswerOptions({ options, mode, value, onChange, label, invalid }) {
  if (mode === 'multi') {
    return (
      <Checkbox.Group aria-label={label} value={Array.isArray(value) ? value : []} onChange={onChange} className={`answer-options ${invalid ? 'answer-options--invalid' : ''}`}>
        {options.map((o) => (
          <Checkbox key={o.id} value={o.id} className="answer-option">
            {o.label}
          </Checkbox>
        ))}
      </Checkbox.Group>
    );
  }
  return (
    <Radio.Group aria-label={label} value={typeof value === 'string' ? value : undefined} onChange={(e) => onChange(e.target.value)} className={`answer-options ${invalid ? 'answer-options--invalid' : ''}`}>
      {options.map((o) => (
        <Radio key={o.id} value={o.id} className="answer-option">
          {o.label}
        </Radio>
      ))}
    </Radio.Group>
  );
}
