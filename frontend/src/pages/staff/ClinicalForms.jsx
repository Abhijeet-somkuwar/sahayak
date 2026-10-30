import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Form, Input, Select } from 'antd';
import { addDiagnosis, addPrescription } from '../../api/encounters';
import { useErrorText } from '../../hooks/useErrorText';
import { FREQUENCIES, ROUTES, rule, validateDiagnosis, validateDurationDays, validateMinLength, validateRequired } from '../../utils/validation';
import { Panel } from '../../components/ui/Dialogs';
import { InlineNotice } from '../../components/ui/Notices';
import './StaffPages.css';

// Diagnosis: one line of text recorded against the encounter. Not optimistic; closes on success.
export function DiagnosisForm({ encounterId, open, onClose, onSaved }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const save = async (v) => {
    setPending(true);
    setError(null);
    try {
      await addDiagnosis(encounterId, v.diagnosis.trim(), true);
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  return (
    <Panel open={open} onClose={onClose} title={t('doctor.diagnosis')}>
      <Form layout="vertical" requiredMark={false} onFinish={save} className="stack" scrollToFirstError={false} preserve={false}>
        <Form.Item name="diagnosis" label={t('doctor.diagnosis')} rules={[rule(validateDiagnosis, t)]} validateTrigger="onSubmit">
          <Input.TextArea rows={4} autoFocus />
        </Form.Item>
        {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="primary" htmlType="submit" loading={pending}>
            {t('common.save')}
          </Button>
        </div>
      </Form>
    </Panel>
  );
}

const emptyItem = { drug_name: '', dose: '', frequency: 'BD', duration_days: '', route: 'oral' };

// Prescription: one or more items, each saved as its own record on the encounter.
export function PrescriptionForm({ encounterId, open, onClose, onSaved }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const save = async (v) => {
    setPending(true);
    setError(null);
    try {
      for (const item of v.items) {
        await addPrescription(encounterId, {
          drug_name: item.drug_name.trim(),
          dose: item.dose.trim(),
          frequency: item.frequency,
          duration_days: Number(item.duration_days),
          route: item.route,
          instructions_i18n: item.instructions && item.instructions.trim() ? { en: item.instructions.trim() } : {},
        });
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  return (
    <Panel open={open} onClose={onClose} title={t('doctor.prescription')} wide>
      <Form layout="vertical" requiredMark={false} onFinish={save} className="stack" initialValues={{ items: [emptyItem] }} scrollToFirstError={false} preserve={false}>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((field, i) => (
                <div key={field.key} className="rx-row">
                  <Form.Item name={[field.name, 'drug_name']} label={t('doctor.rx.drug')} rules={[rule(validateMinLength(2, 'v.drug.required'), t)]} validateTrigger="onSubmit" style={{ marginBottom: 0 }}>
                    <Input autoFocus={i === 0} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'dose']} label={t('doctor.rx.dose')} rules={[rule(validateRequired('v.dose.required'), t)]} validateTrigger="onSubmit" style={{ marginBottom: 0 }}>
                    <Input />
                  </Form.Item>
                  <Form.Item name={[field.name, 'frequency']} label={t('doctor.rx.frequency')} style={{ marginBottom: 0 }}>
                    <Select options={FREQUENCIES.map((f) => ({ value: f, label: f }))} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'duration_days']} label={t('doctor.rx.duration')} rules={[rule(validateDurationDays, t)]} validateTrigger="onSubmit" style={{ marginBottom: 0 }}>
                    <Input inputMode="numeric" />
                  </Form.Item>
                  <Form.Item name={[field.name, 'route']} label={t('doctor.rx.route')} style={{ marginBottom: 0 }}>
                    <Select options={ROUTES.map((r) => ({ value: r, label: r }))} />
                  </Form.Item>
                  <Form.Item name={[field.name, 'instructions']} label={t('doctor.rx.instructions')} style={{ marginBottom: 0 }}>
                    <Input placeholder="After food" maxLength={200} />
                  </Form.Item>
                  <Button type="text" onClick={() => remove(field.name)} disabled={fields.length === 1} aria-label={t('doctor.removeItem')}>
                    ×
                  </Button>
                </div>
              ))}
              <Button onClick={() => add(emptyItem)} style={{ alignSelf: 'flex-start' }}>
                + {t('doctor.addItem')}
              </Button>
            </>
          )}
        </Form.List>
        {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="primary" htmlType="submit" loading={pending}>
            {t('common.save')}
          </Button>
        </div>
      </Form>
    </Panel>
  );
}
