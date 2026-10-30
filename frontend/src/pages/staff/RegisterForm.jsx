import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Form, Input, Radio, Select } from 'antd';
import { createPatient } from '../../api/patients';
import { useErrorText } from '../../hooks/useErrorText';
import { useBlurValidation } from '../../hooks/useBlurValidation';
import { ApiError } from '../../utils/errors';
import { normalizeIndianMobile, RELATIONSHIPS, rule, validateAgeOrYear, validateName, validateOptionalPhone, validateRequired } from '../../utils/validation';
import ErrorSummary from '../../components/ui/ErrorSummary';
import AgeOrYearField from '../../components/ui/AgeOrYearField';
import { InlineNotice } from '../../components/ui/Notices';
import './StaffPages.css';

const thisYear = new Date().getFullYear();

/** Inline registration. On 409 possible_duplicates the candidates are shown side by side. */
export default function RegisterForm({ onCancel, onRegistered }) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const [form] = Form.useForm();
  const onBlur = useBlurValidation(form);
  const [summary, setSummary] = useState([]);
  const [candidates, setCandidates] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);

  const toBody = (v, force) => ({
    display_name: v.display_name.trim(),
    sex: v.sex,
    age_years: v.age.kind === 'year' ? thisYear - Number(v.age.value) : Number(v.age.value),
    district_code: v.district_code.trim(),
    phone: v.phone && v.phone.trim() ? `+91${normalizeIndianMobile(v.phone)}` : undefined,
    relationship: v.relationship || 'self',
    preferred_language: 'hi',
    force,
  });

  const submit = async (v, force = false) => {
    setSummary([]);
    setPending(true);
    setError(null);
    try {
      const body = toBody(v, force);
      const row = await createPatient(body);
      onRegistered({ ...row, relationship: body.relationship });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'possible_duplicates') {
        setDraft(v);
        setCandidates(e.extra.candidates || []);
      } else setError(e);
    } finally {
      setPending(false);
    }
  };

  if (candidates) {
    return (
      <div className="stack" style={{ maxWidth: 720 }}>
        <h2 className="text-xl">{t('counter.dup.title')}</h2>
        <p className="text-soft">{t('counter.dup.body')}</p>
        <div className="dup-grid">
          <div className="dup-card" style={{ background: 'var(--paper)' }}>
            <p className="text-sm text-soft">{t('counter.registerNew')}</p>
            <p className="text-lg" style={{ fontWeight: 500 }}>{draft.display_name}</p>
            <p>
              {t(`common.sex.${draft.sex}`)} · {draft.age.kind === 'age' ? draft.age.value : thisYear - Number(draft.age.value)} · {draft.district_code}
            </p>
          </div>
          {candidates.map((c) => (
            <div key={c.id} className="dup-card">
              <p className="text-lg" style={{ fontWeight: 500 }}>{c.display_name}</p>
              <p>
                {t(`common.sex.${c.sex || 'unknown'}`)} · {c.birth_year ? thisYear - c.birth_year : '—'}
              </p>
              <Button type="primary" onClick={() => onRegistered(c)}>
                {t('counter.dup.use')}
              </Button>
            </div>
          ))}
        </div>
        <div className="row">
          <Button onClick={() => setCandidates(null)}>{t('common.back')}</Button>
          <Button onClick={() => submit(draft, true)} loading={pending}>
            {t('counter.dup.different')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Form
      form={form}
      layout="vertical"
      requiredMark={false}
      className="stack"
      style={{ maxWidth: 560 }}
      initialValues={{ age: { kind: 'age', value: '' }, relationship: 'self' }}
      onFinish={(v) => submit(v)}
      onFinishFailed={({ errorFields }) => setSummary(errorFields.map((f) => ({ name: f.name[0], message: f.errors[0] })))}
      scrollToFirstError={false}
    >
      <h2 className="text-xl">{t('counter.registerNew')}</h2>
      <ErrorSummary title={t('err.summaryTitle', { count: summary.length })} items={summary} fieldIds={{ display_name: 'display_name', sex: 'sex', age: 'age', district_code: 'district_code', phone: 'phone' }} />

      <Form.Item name="display_name" label={t('counter.form.name')} rules={[rule(validateName, t)]} validateTrigger="onSubmit">
        <Input autoFocus onBlur={onBlur('display_name')} />
      </Form.Item>
      <Form.Item name="sex" label={t('counter.form.sex')} rules={[rule(validateRequired('v.sex.required'), t)]} validateTrigger="onSubmit">
        <Radio.Group
          optionType="button"
          buttonStyle="solid"
          options={['female', 'male', 'other', 'unknown'].map((s) => ({ value: s, label: t(`common.sex.${s}`) }))}
        />
      </Form.Item>
      <Form.Item name="age" label={t('counter.form.ageKind')} rules={[rule(validateAgeOrYear, t)]} validateTrigger="onSubmit">
        <AgeOrYearField labels={{ group: t('counter.form.ageKind'), age: t('counter.form.age'), year: t('counter.form.year') }} />
      </Form.Item>
      <Form.Item name="phone" label={t('counter.form.phone')} rules={[rule(validateOptionalPhone, t)]} validateTrigger="onSubmit">
        <Input type="tel" inputMode="numeric" maxLength={16} onBlur={onBlur('phone')} />
      </Form.Item>
      <Form.Item name="relationship" label={t('counter.form.relationship')}>
        <Select options={RELATIONSHIPS.map((r) => ({ value: r, label: t(`counter.rel.${r}`) }))} />
      </Form.Item>
      <Form.Item name="district_code" label={t('counter.form.district')} rules={[rule(validateRequired('v.district.required'), t)]} validateTrigger="onSubmit">
        <Input onBlur={onBlur('district_code')} />
      </Form.Item>

      {error && <InlineNotice tone="error">{errorText(error)}</InlineNotice>}
      <div className="row">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button type="primary" htmlType="submit" loading={pending}>
          {t('counter.form.submit')}
        </Button>
      </div>
    </Form>
  );
}
