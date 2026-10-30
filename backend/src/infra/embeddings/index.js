/**
 * Embeddings provider interface (§5.1, §20 open decision 2). Multilingual, 1024-dim.
 *  - mock:   deterministic hashed character n-grams; dev/tests only (never in production, enforced by env.ts)
 *  - http:   OpenAI-compatible POST {base}/embeddings — works for self-hosted BGE-M3 behind TEI/vLLM
 *  - voyage: Voyage AI multilingual API
 */
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../logger.js';

function normalise(v) {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export class MockEmbeddings {
  model = env.EMBEDDINGS_MODEL || 'mock-1024';
  dim = env.EMBEDDINGS_DIM;
  async embed(texts) {
    return texts.map((t) => this.one(t));
  }
  one(text) {
    const v = new Array(this.dim).fill(0);
    const s = ` ${text.toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim()} `;
    const feats = [];
    for (const w of s.split(' ')) if (w) feats.push(`w:${w}`);
    for (let i = 0; i + 3 <= s.length; i++) feats.push(`g:${s.slice(i, i + 3)}`);
    for (const f of feats) {
      const h = createHash('md5').update(f).digest();
      const idx = h.readUInt32BE(0) % this.dim;
      const sign = (h[4] & 1) === 0 ? 1 : -1;
      v[idx] += sign * (f.startsWith('w:') ? 2 : 1);
    }
    return normalise(v);
  }
}

class HttpEmbeddings {
  model = env.EMBEDDINGS_MODEL;
  dim = env.EMBEDDINGS_DIM;
  constructor(url, extra = {}) {
    this.url = url;
    this.extra = extra;
  }
  async embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64);
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(env.EMBEDDINGS_API_KEY ? { authorization: `Bearer ${env.EMBEDDINGS_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: batch, ...this.extra }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`embeddings provider returned ${res.status}`);
      const json = await res.json();
      const rows = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
      for (const r of rows) {
        if (r.length !== this.dim) throw new Error(`embedding dimension ${r.length} != ${this.dim}; never mix models in one index (§9.7)`);
        out.push(r);
      }
    }
    return out;
  }
}

let provider;
export function embeddings() {
  if (provider) return provider;
  switch (env.EMBEDDINGS_PROVIDER) {
    case 'http':
      provider = new HttpEmbeddings(`${env.EMBEDDINGS_BASE_URL.replace(/\/$/, '')}/embeddings`);
      break;
    case 'voyage':
      provider = new HttpEmbeddings('https://api.voyageai.com/v1/embeddings', {
        input_type: 'document',
        output_dimension: env.EMBEDDINGS_DIM,
      });
      break;
    default:
      if (env.NODE_ENV !== 'test') logger.warn('EMBEDDINGS_PROVIDER=mock: deterministic hashed embeddings; dev/demo only');
      provider = new MockEmbeddings();
  }
  return provider;
}

export async function embedOne(text) {
  const [v] = await embeddings().embed([text]);
  return v;
}

export function setEmbeddingsProvider(p) {
  provider = p;
}
