/**
 * Speech-to-text provider interface (phase 2, §9.3). Bhashini is recommended (§20 open decision 11).
 * Low-confidence transcripts (< 0.6) are confirmed with the patient or replaced by the symptom menu.
 */
import { env } from '../../config/env.js';

class NoneAsr {
  async transcribe() {
    return null;
  }
}

/** Bhashini ASR pipeline adapter. Requires ASR_API_KEY and a configured pipeline; returns null when unavailable. */
class BhashiniAsr {
  async transcribe(audio, _mime, languageHint) {
    if (!env.ASR_API_KEY) return null;
    try {
      const res = await fetch('https://dhruva-api.bhashini.gov.in/services/inference/pipeline', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: env.ASR_API_KEY },
        body: JSON.stringify({
          pipelineTasks: [
            {
              taskType: 'asr',
              config: { language: { sourceLanguage: languageHint.split('-')[0] }, audioFormat: 'ogg', samplingRate: 16000 },
            },
          ],
          inputData: { audio: [{ audioContent: audio.toString('base64') }] },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const json = await res.json();
      const text = json.pipelineResponse?.[0]?.output?.[0]?.source?.trim();
      return text ? { text, confidence: 0.7, language: languageHint } : null;
    } catch {
      return null;
    }
  }
}

export const LOW_CONFIDENCE = 0.6;
export function asr() {
  return env.ASR_PROVIDER === 'bhashini' ? new BhashiniAsr() : new NoneAsr();
}
