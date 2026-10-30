import { Input, Radio } from 'antd';

// Age or year of birth: the clerk picks which, validation checks the range.
export default function AgeOrYearField({ value = { kind: 'age', value: '' }, onChange, labels, id, status }) {
  const v = value || { kind: 'age', value: '' };
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Radio.Group
        optionType="button"
        buttonStyle="solid"
        value={v.kind}
        onChange={(e) => onChange({ ...v, kind: e.target.value })}
        options={[
          { value: 'age', label: labels.age },
          { value: 'year', label: labels.year },
        ]}
      />
      <Input id={id} inputMode="numeric" maxLength={4} value={v.value} onChange={(e) => onChange({ ...v, value: e.target.value })} status={status} aria-label={v.kind === 'age' ? labels.age : labels.year} />
    </div>
  );
}
