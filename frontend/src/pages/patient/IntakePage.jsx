import { Fragment, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button, Input } from 'antd';
import { answerIntake, getIntake } from '../../api/intake';
import { useErrorText } from '../../hooks/useErrorText';
import { useIdempotencyKey } from '../../services/idempotency';
import AnswerOptions from '../../components/ui/AnswerOptions';
import VoiceInput from '../../components/ui/VoiceInput';
import { InlineNotice } from '../../components/ui/Notices';
import { AssistantHeader, Thinking, UnderstoodCard } from '../../components/patient/Assistant';
import { BookingOutcome, EmergencyOutcome } from './Outcomes';
import { clearIntake, loadIntake, saveIntake } from './intakeStore';
import '../../components/patient/Patient.css';
import './PatientPages.css';

const MAX_QUESTIONS = 5; // the engine asks at most five follow-up questions

/**
 * Conversational intake with the Sahayak assistant. The engine returns messages; the last one carries
 * buttons (≤3), a list (≤10 rows) or asks for free text. Every sentence the patient reads comes from the
 * backend's reviewed templates; the assistant cards render structured data (catalogue symptom labels,
 * urgency level, department), never AI-written text.
 */
export default function IntakePage() {
  const { sessionId } = useParams();
  const { t } = useTranslation();
  const errorText = useErrorText();
  const idem = useIdempotencyKey();
  const [conv, setConv] = useState(() => loadIntake(sessionId)); // { session_id, state, encounter_id, messages, assistant, rows }
  const [loadError, setLoadError] = useState(null);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState(null);
  const endRef = useRef(null);

  useEffect(() => {
    if (conv) return undefined;
    let alive = true;
    getIntake(sessionId)
      .then((r) => alive && setConv({ ...r, rows: [] }))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [sessionId, conv]);

  // keep the newest message in view
  const rowCount = conv && conv.rows ? conv.rows.length : 0;
  useEffect(() => {
    if (endRef.current && endRef.current.scrollIntoView) endRef.current.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [rowCount, pending]);

  const messages = (conv && conv.messages) || [];
  const last = messages[messages.length - 1] || null;
  const bookingMsg = messages.find((m) => m.link && m.link.startsWith('sahayak:enc:'));
  const emergencyMsg = messages.find((m) => /^triage\.(emergency|self_harm)/.test(m.templateCode || ''));
  const assistant = (conv && conv.assistant) || null;

  const submit = async (event, label) => {
    setPending(true);
    setActionError(null);
    try {
      const r = await answerIntake(sessionId, event, idem.get());
      idem.reset();
      const before = conv.assistant && conv.assistant.understood;
      const now = r.assistant && r.assistant.understood;
      const row = { q: messages.map((m) => m.text).join('\n\n'), a: label, understood: !before && now ? now : null };
      const next = { ...r, rows: [...(conv.rows || []), row] };
      setConv(next);
      if (r.messages.some((m) => m.link && m.link.startsWith('sahayak:enc:'))) clearIntake(sessionId);
      else saveIntake(sessionId, next);
    } catch (e) {
      setActionError(e);
    } finally {
      setPending(false);
    }
  };

  if (loadError) return <InlineNotice tone="error">{errorText(loadError)}</InlineNotice>;
  if (!conv) return <p className="text-soft" style={{ paddingTop: 40 }}>{t('common.loading')}…</p>;
  if (emergencyMsg) return <EmergencyOutcome text={emergencyMsg.text} assistant={assistant} />;
  if (bookingMsg) return <BookingOutcome message={bookingMsg} encounterId={bookingMsg.link.replace('sahayak:enc:', '')} assistant={assistant} />;

  const thinkingText = conv.state === 'complaint' ? t('intake.ai.reading') : t('intake.ai.thinking');
  const showProgress = conv.state === 'clarify' && assistant && assistant.questions_asked > 0;

  return (
    <div className="patient-page" style={{ gap: 16 }}>
      <AssistantHeader mode={assistant && assistant.mode} />
      <ol className="chat-log" aria-label={t('intake.title')}>
        {(conv.rows || []).map((r, i) => (
          <Fragment key={i}>
            <li className="bubble bubble--bot">{r.q}</li>
            <li className="bubble bubble--me">{r.a}</li>
            {r.understood && (
              <li style={{ display: 'flex' }}>
                <UnderstoodCard understood={r.understood} />
              </li>
            )}
          </Fragment>
        ))}
        {pending && (
          <li style={{ display: 'flex' }}>
            <Thinking text={thinkingText} />
          </li>
        )}
      </ol>
      {!pending && last && (
        <StepView
          key={`${conv.state}:${messages.length}:${last.templateCode}:${rowCount}`}
          messages={messages}
          message={last}
          progress={showProgress ? t('intake.questionOf', { index: Math.min(assistant.questions_asked, MAX_QUESTIONS), total: MAX_QUESTIONS }) : null}
          pending={pending}
          error={actionError ? errorText(actionError) : null}
          onChoice={(id, title) => submit({ kind: 'choice', id, title }, title)}
          onText={(text) => submit({ kind: 'text', text }, text)}
        />
      )}
      {!last && <p className="text-soft">{t('intake.resume')}</p>}
      <div ref={endRef} />
    </div>
  );
}

function StepView({ messages, message, progress, pending, error, onChoice, onText }) {
  const { t } = useTranslation();
  const options = message.buttons ? message.buttons.map((b) => ({ id: b.id, label: b.title })) : message.list ? message.list.rows.map((r) => ({ id: r.id, label: r.description ? `${r.title} · ${r.description}` : r.title })) : null;
  const [value, setValue] = useState('');
  const [localError, setLocalError] = useState(null);
  const question = message.text || '';
  const earlier = messages.slice(0, -1).map((m) => m.text).filter(Boolean);

  const submit = (e) => {
    e.preventDefault();
    if (!String(value).trim()) {
      setLocalError(t('intake.answerRequired'));
      return;
    }
    if (options) {
      const o = options.find((x) => x.id === value);
      onChoice(value, o ? o.label : value);
    } else onText(value.trim());
  };

  return (
    <form className="stack" onSubmit={submit}>
      {earlier.map((text, i) => (
        <div key={i} className="bubble bubble--bot text-lg">
          {text}
        </div>
      ))}
      <div className="bubble bubble--bot">
        {progress && <p className="intake-progress" style={{ textAlign: 'left', marginBottom: 4 }}>{progress}</p>}
        <p className="intake-question">{question}</p>
      </div>

      {options ? (
        <AnswerOptions
          options={options}
          mode="single"
          value={value}
          onChange={(v) => {
            setValue(v);
            setLocalError(null);
          }}
          label={question}
          invalid={!!localError}
        />
      ) : (
        <>
          <Input.TextArea
            aria-label={question}
            placeholder={t('intake.describePlaceholder')}
            rows={4}
            size="large"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setLocalError(null);
            }}
            status={localError ? 'error' : ''}
            autoFocus
          />
          <div className="intake-voice">
            <VoiceInput
              onRecorded={() => setValue((v) => v || '🎤')}
              labels={{ record: t('intake.record'), stop: t('intake.stopRecording'), recording: (s) => t('intake.recording', { seconds: s }), denied: t('intake.voiceDenied') }}
            />
          </div>
        </>
      )}

      {localError && (
        <p role="alert" style={{ color: 'var(--triage-emergency)' }}>
          {localError}
        </p>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}

      <div className="intake-actions">
        <Button size="large" type="primary" htmlType="submit" loading={pending} block>
          {t('common.continue')}
        </Button>
      </div>
    </form>
  );
}
