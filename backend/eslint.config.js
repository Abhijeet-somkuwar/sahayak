// @ts-check
import js from '@eslint/js';

/**
 * Custom rules required by BACKEND_DESIGN.md §13.1 and §17:
 *  - no string-built SQL (only Kysely builders / sql`` tagged templates)
 *  - queries on PHI tables only inside repo.ts files
 *  - no crypto.randomUUID() for database ids (UUIDv4) — use newId() (UUIDv7)
 */
const PHI_TABLES = [
  'patients', 'patient_identifiers', 'patient_contacts', 'contact_points', 'consents', 'allergies', 'conditions',
  'patient_clinical_summaries', 'encounters', 'triage_assessments', 'prebriefs', 'encounter_diagnoses',
  'prescription_items', 'observations', 'followups', 'messages', 'patient_documents', 'patient_doc_chunks',
];

/** @type {import('eslint').Rule.RuleModule} */
const noPhiOutsideRepo = {
  meta: { type: 'problem', docs: { description: 'PHI tables may only be queried inside repo.js files (§17.6)' }, schema: [] },
  create(context) {
    const filename = String(context.filename ?? context.getFilename()).split('\\').join('/'); // Windows paths too
    const allowed = /(^|\/)repo\.js$|(^|\/)db\/seeds\/|(^|\/)test\/|(^|\/)__tests__\/|(^|\/)scripts\/|(^|\/)infra\/|(^|\/)shared\/(audit|access|outbox)\.js$/.test(filename);
    if (allowed) return {};
    const re = new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+(${PHI_TABLES.join('|')})\\b`, 'i');
    const check = (node, text) => {
      if (re.test(text)) context.report({ node, message: `SQL on a PHI table outside repo.js: ${text.match(re)?.[0]}` });
    };
    return {
      TemplateElement(node) { check(node, node.value.raw); },
      Literal(node) { if (typeof node.value === 'string') check(node, node.value); },
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'MemberExpression' && c.property.type === 'Identifier' &&
            ['selectFrom', 'insertInto', 'updateTable', 'deleteFrom'].includes(c.property.name)) {
          const a = node.arguments[0];
          if (a && a.type === 'Literal' && typeof a.value === 'string' && PHI_TABLES.includes(a.value)) {
            context.report({ node, message: `Kysely query on PHI table '${a.value}' outside repo.js` });
          }
        }
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const noStringBuiltSql = {
  meta: { type: 'problem', docs: { description: 'SQL must be parameterised; never concatenate strings into SQL (§13.1)' }, schema: [] },
  create(context) {
    const sqlStart = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP)\b/i;
    return {
      BinaryExpression(node) {
        if (node.operator !== '+') return;
        const left = node.left;
        if (left.type === 'Literal' && typeof left.value === 'string' && sqlStart.test(left.value)) {
          context.report({ node, message: 'String-built SQL is forbidden; use sql`` tagged templates or Kysely builders' });
        }
      },
      TemplateLiteral(node) {
        const parent = node.parent;
        const isTagged = parent && parent.type === 'TaggedTemplateExpression';
        if (isTagged) return;
        const first = node.quasis[0]?.value.raw ?? '';
        if (node.expressions.length > 0 && sqlStart.test(first)) {
          context.report({ node, message: 'Untagged template literal containing SQL with interpolation; use the sql`` tag' });
        }
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const noRandomUuid = {
  meta: { type: 'problem', docs: { description: 'crypto.randomUUID() is UUIDv4; use newId() (UUIDv7) for database ids (§17.2)' }, schema: [] },
  create(context) {
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && c.property.name === 'randomUUID') {
          context.report({ node, message: 'crypto.randomUUID() generates UUIDv4; use newId() from shared/ids.js' });
        }
      },
    };
  },
};

export default [
  { ignores: ['node_modules/**', 'load/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { process: 'readonly', Buffer: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly', AbortController: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', crypto: 'readonly', structuredClone: 'readonly', performance: 'readonly', queueMicrotask: 'readonly', Blob: 'readonly', File: 'readonly', FormData: 'readonly', Headers: 'readonly', Request: 'readonly', Response: 'readonly', globalThis: 'readonly', AbortSignal: 'readonly', Event: 'readonly', EventTarget: 'readonly', WebSocket: 'readonly' } },
    plugins: { sahayak: { rules: { 'no-phi-outside-repo': noPhiOutsideRepo, 'no-string-built-sql': noStringBuiltSql, 'no-random-uuid': noRandomUuid } } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-misleading-character-class': 'off', // Indic combining marks in phone/name normalisation are intentional
      'sahayak/no-phi-outside-repo': 'error',
      'sahayak/no-string-built-sql': 'error',
      'sahayak/no-random-uuid': 'error',
    },
  },
];
