import { Form, Input } from 'antd';

const FIELDS = [
  { key: 'bpSystolic', label: 'BP systolic', unit: 'mmHg' },
  { key: 'bpDiastolic', label: 'BP diastolic', unit: 'mmHg' },
  { key: 'pulse', label: 'Pulse', unit: '/min' },
  { key: 'tempC', label: 'Temperature', unit: '°C' },
  { key: 'spo2', label: 'SpO₂', unit: '%' },
  { key: 'weightKg', label: 'Weight', unit: 'kg' },
  { key: 'rbsMgDl', label: 'RBS', unit: 'mg/dL' },
];

// Dense vitals entry. errors block submit; warnings (clinically unusual values) need a "confirm".
export default function VitalsGrid({ values, onChange, errors = {}, warnings = {} }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12 }}>
      {FIELDS.map((f) => (
        <Form.Item
          key={f.key}
          label={`${f.label} (${f.unit})`}
          validateStatus={errors[f.key] ? 'error' : warnings[f.key] ? 'warning' : ''}
          help={errors[f.key] || warnings[f.key]}
          style={{ marginBottom: 0 }}
        >
          <Input inputMode="decimal" value={values[f.key] || ''} onChange={(e) => onChange(f.key, e.target.value)} />
        </Form.Item>
      ))}
    </div>
  );
}
