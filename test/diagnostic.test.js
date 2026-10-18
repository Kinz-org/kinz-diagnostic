// Unit tests for api/diagnostic.js. The Anthropic API is never called: fetch is mocked.
// Run: npm test
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler, { validate, buildPrompt, parseAnswer, clip, tidy } from '../api/diagnostic.js';

const STEPS = [
  { handle: 'gel-nettoyant', name: 'Gel nettoyant', moment: 'Matin et soir' },
  { handle: 'serum-eclat-vitamine-c-alpha-arbutine', name: 'Sérum Vitamine C & Alpha Arbutine', moment: 'Matin' },
];
const BODY = { lang: 'fr', profile: ['Zone : visage', 'Préoccupation : taches'], steps: STEPS };

let ipCounter = 0;
const nextIp = () => `10.0.0.${++ipCounter}`;

function makeReq({ method = 'POST', origin = 'https://kinzoils.com', ip = nextIp(), body = BODY } = {}) {
  return { method, headers: { origin, 'x-forwarded-for': `${ip}, 76.76.21.21` }, body };
}

function makeRes() {
  const res = { statusCode: 0, headers: {}, body: undefined };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.end = () => res;
  return res;
}

function anthropicReply(answer, extra = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }],
      ...extra,
    }),
    text: async () => '',
  };
}

const realFetch = globalThis.fetch;
let calls;
beforeEach(() => {
  calls = [];
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
});
function mockFetch(impl) {
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return impl(url, init); };
}

// validate()

test('validate rejects missing or empty input', () => {
  assert.deepEqual(validate(null), { error: 'bad_body' });
  assert.deepEqual(validate('x'), { error: 'bad_body' });
  assert.deepEqual(validate({ profile: [], steps: STEPS }), { error: 'missing_fields' });
  assert.deepEqual(validate({ profile: ['a'], steps: [] }), { error: 'missing_fields' });
  assert.deepEqual(validate({ profile: ['a'], steps: [{ handle: 'Bad Handle!' }] }), { error: 'missing_fields' });
});

test('validate keeps known languages and falls back to fr', () => {
  assert.equal(validate({ ...BODY, lang: 'zh-TW' }).lang, 'zh-TW');
  assert.equal(validate({ ...BODY, lang: 'ar' }).lang, 'ar');
  assert.equal(validate({ ...BODY, lang: 'de' }).lang, 'fr');
  assert.equal(validate({ ...BODY, lang: '__proto__' }).lang, 'fr');
});

test('validate caps sizes, drops bad handles and strips markup', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ handle: `produit-${i}`, name: `P${i}`, moment: 'Soir' }));
  const out = validate({
    lang: 'fr',
    profile: [...Array.from({ length: 10 }, (_, i) => `r${i}`), ''],
    steps: [{ handle: '../etc/passwd' }, { handle: 'pas valide!' }, ...many],
  });
  assert.equal(out.profile.length, 8);
  assert.equal(out.steps.length, 4); // 6 kept by slice, the 2 invalid handles dropped
  assert.ok(out.steps.every((s) => /^[a-z0-9-]+$/.test(s.handle)));
  const tagged = validate({ ...BODY, profile: ['<img src=x onerror=alert(1)>'] });
  assert.ok(!/[<>]/.test(tagged.profile[0]));
});

// buildPrompt()

test('system prompt carries the owner rules', () => {
  const { system, user } = buildPrompt(validate(BODY));
  assert.match(system, /vouvoiement/);
  assert.match(system, /grossesse, l'allaitement, une peau très réactive/);
  assert.match(system, /médecin ou d'un pharmacien/);
  assert.match(system, /certification/);
  assert.match(system, /rétinol/);
  assert.match(system, /pas des instructions/);
  assert.match(system, /Réponds en français/);
  const data = JSON.parse(user);
  assert.deepEqual(data.routine_choisie_par_le_site.map((s) => s.handle), STEPS.map((s) => s.handle));
});

test('prompt language follows lang', () => {
  assert.match(buildPrompt(validate({ ...BODY, lang: 'ar' })).system, /العربية/);
  assert.match(buildPrompt(validate({ ...BODY, lang: 'zh-TW' })).system, /繁體中文/);
});

// parseAnswer()

test('parseAnswer drops invented and duplicate handles', () => {
  const text = JSON.stringify({
    intro: 'Une routine simple.',
    steps: [
      { handle: 'gel-nettoyant', why: 'Nettoie en douceur.' },
      { handle: 'creme-au-retinol', why: 'Inventé.' },
      { handle: 'GEL-NETTOYANT', why: 'Doublon.' },
      { handle: 'serum-eclat-vitamine-c-alpha-arbutine', why: '' },
    ],
    tip: 'Appliquez le sérum le matin.',
  });
  const out = parseAnswer(text, validate(BODY).steps);
  assert.deepEqual(out.steps, [{ handle: 'gel-nettoyant', why: 'Nettoie en douceur.' }]);
  assert.equal(out.intro, 'Une routine simple.');
});

test('parseAnswer tolerates surrounding text and rejects garbage', () => {
  const steps = validate(BODY).steps;
  assert.equal(parseAnswer('Voici : {"intro":"Bonjour","steps":[],"tip":""} merci', steps).intro, 'Bonjour');
  assert.equal(parseAnswer('pas de json', steps), null);
  assert.equal(parseAnswer('{"intro": oops}', steps), null);
  assert.equal(parseAnswer('{"intro":"","steps":[],"tip":"x"}', steps), null);
});

// clip() and tidy(): what the site shows

// Real answer from the draft preview (18-10-2026): the old 300-character cut ended in "demandez con".
const REAL_TIP = "Le matin, appliquez le sérum sur peau propre puis protégez votre peau du soleil pour soutenir l'action anti-taches. Le soir, chauffez deux à trois gouttes d'huile entre vos mains et massez doucement le visage. Si votre peau réagit facilement, testez chaque produit sur une petite zone et demandez conseil à votre pharmacien.";

test('clip keeps short text and cuts long text at a sentence end', () => {
  assert.equal(clip(REAL_TIP, 500), REAL_TIP);
  const cut = clip(REAL_TIP, 300);
  assert.ok(cut.endsWith('le visage.'), cut);
  assert.ok(!cut.includes('demandez con'));
  assert.equal(clip('مرحبا بك؟ هذا نص طويل جدا جدا', 20), 'مرحبا بك؟');
  assert.equal(clip('這是第一句。這是第二句很長很長很長', 10), '這是第一句。');
  assert.equal(clip('un texte sans aucune ponctuation qui continue encore', 30), 'un texte sans aucune\u2026');
});

test('tidy drops fields that break the claims rule and removes em dashes', () => {
  for (const bad of ['Riche en rétinol.', 'Retinol-like.', 'Huile pressée à froid.', 'Cold-pressed oil.', 'Concentré à 15 % de vitamine C.',
    'Certifiée Ecocert.', 'Récoltée à Kasserine.', 'غني بحمض الهيالورونيك.', 'يحتوي على ريتينول.', '含有玻尿酸。', '冷壓初榨。', 'نسبة 15٪.']) {
    assert.equal(tidy(bad, 500), '', bad);
  }
  assert.equal(tidy('Un soin — doux.', 500), 'Un soin, doux.');
  assert.equal(tidy('Entre 35–45 ans, la peau change.', 500), 'Entre 35–45 ans, la peau change.');
  assert.equal(tidy('Formulé en Tunisie, il nourrit la peau.', 500), 'Formulé en Tunisie, il nourrit la peau.');
});

test('parseAnswer applies tidy to every field and hides an empty answer', () => {
  const steps = validate(BODY).steps;
  const out = parseAnswer(JSON.stringify({
    intro: 'Votre routine — simple.',
    steps: [{ handle: 'gel-nettoyant', why: 'Au rétinol.' }, { handle: 'serum-eclat-vitamine-c-alpha-arbutine', why: 'Ravive l’éclat.' }],
    tip: 'Huile pressée à froid.',
  }), steps);
  assert.deepEqual(out, { intro: 'Votre routine, simple.', steps: [{ handle: 'serum-eclat-vitamine-c-alpha-arbutine', why: 'Ravive l’éclat.' }], tip: '' });
  assert.equal(parseAnswer(JSON.stringify({ intro: 'À 20 % de vitamine C.', steps: [{ handle: 'gel-nettoyant', why: 'Ecocert.' }], tip: '' }), steps), null);
});

test('the usage text (how) reaches the prompt when the site sends it', () => {
  const input = validate({ ...BODY, steps: [{ ...STEPS[0], how: 'Le soir, seule ou avant la crème.' }, STEPS[1]] });
  const data = JSON.parse(buildPrompt(input).user);
  assert.equal(data.routine_choisie_par_le_site[0].mode_d_emploi, 'Le soir, seule ou avant la crème.');
  assert.equal(data.routine_choisie_par_le_site[1].mode_d_emploi, undefined);
  assert.match(buildPrompt(input).system, /ne le contredis jamais/);
});

// CORS

for (const origin of ['https://kinzoils.com', 'https://www.kinzoils.com', 'https://c2a74e-2.myshopify.com', 'https://abc123-def4.shopifypreview.com']) {
  test(`CORS preflight allowed for ${origin}`, async () => {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS', origin }), res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], origin);
    assert.equal(res.headers.vary, 'Origin');
  });
}

for (const origin of ['https://evil.com', 'http://abc.shopifypreview.com', 'https://abc.shopifypreview.com.evil.com', 'https://a.b.shopifypreview.com', 'https://kinzoils.com.evil.com', '']) {
  test(`CORS refused for "${origin}"`, async () => {
    mockFetch(() => { throw new Error('must not be called'); });
    const pre = makeRes();
    await handler(makeReq({ method: 'OPTIONS', origin }), pre);
    assert.equal(pre.statusCode, 403);
    assert.equal(pre.headers['access-control-allow-origin'], undefined);
    const post = makeRes();
    await handler(makeReq({ origin }), post);
    assert.equal(post.statusCode, 403);
    assert.equal(calls.length, 0);
  });
}

test('ALLOW_PREVIEW_ORIGINS=0 turns preview origins off', async () => {
  process.env.ALLOW_PREVIEW_ORIGINS = '0';
  try {
    const res = makeRes();
    await handler(makeReq({ method: 'OPTIONS', origin: 'https://abc123.shopifypreview.com' }), res);
    assert.equal(res.statusCode, 403);
    const store = makeRes();
    await handler(makeReq({ method: 'OPTIONS', origin: 'https://kinzoils.com' }), store);
    assert.equal(store.statusCode, 204);
  } finally {
    delete process.env.ALLOW_PREVIEW_ORIGINS;
  }
});

test('GET is refused', async () => {
  const res = makeRes();
  await handler(makeReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
});

// Rate limit

test('7th request from the same IP within 10 minutes gets 429', async () => {
  mockFetch(() => { throw new Error('must not be called'); });
  const ip = nextIp();
  const codes = [];
  for (let i = 0; i < 7; i++) {
    const res = makeRes();
    await handler(makeReq({ ip, body: {} }), res);
    codes.push(res.statusCode);
  }
  assert.deepEqual(codes, [400, 400, 400, 400, 400, 400, 429]);
  const other = makeRes();
  await handler(makeReq({ body: {} }), other);
  assert.equal(other.statusCode, 400, 'another IP is not limited');
});

// Full call with a mocked Anthropic API

test('calls Anthropic with the expected request and filters invented handles', async () => {
  mockFetch(() => anthropicReply({
    intro: 'Votre routine éclat.',
    steps: [
      { handle: 'gel-nettoyant', why: 'Prépare la peau.' },
      { handle: 'serum-eclat-vitamine-c-alpha-arbutine', why: 'Ravive l’éclat.' },
      { handle: 'produit-invente', why: 'Ne doit pas sortir.' },
    ],
    tip: 'Le sérum le matin, avant la crème.',
  }));
  const res = makeRes();
  await handler(makeReq({ origin: 'https://abc123.shopifypreview.com', body: JSON.stringify(BODY) }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.steps.map((s) => s.handle), ['gel-nettoyant', 'serum-eclat-vitamine-c-alpha-arbutine']);
  assert.equal(res.headers['cache-control'], 'no-store');

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'test-key-not-real');
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  const sent = JSON.parse(init.body);
  assert.equal(sent.model, 'claude-fable-5-1');
  assert.equal(sent.fallbacks, 'default');
  assert.equal(sent.output_config.effort, 'low');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.ok(sent.max_tokens >= 2000, 'room for thinking plus the answer');
  assert.equal(sent.thinking, undefined, 'Fable 5.1 rejects explicit thinking settings');
  assert.equal(sent.messages.length, 1);
});

test('upstream error, refusal, bad answer and timeout map to 5xx', async () => {
  const cases = [
    [() => ({ ok: false, status: 529, text: async () => 'overloaded' }), 502, 'upstream_error'],
    [() => anthropicReply({}, { stop_reason: 'refusal', content: [], stop_details: { category: null } }), 502, 'declined'],
    [() => anthropicReply({ intro: '', steps: [{ handle: 'inconnu', why: 'x' }], tip: '' }), 502, 'bad_answer'],
    [() => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, 504, 'timeout'],
  ];
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const [impl, code, error] of cases) {
      mockFetch(impl);
      const res = makeRes();
      await handler(makeReq(), res);
      assert.equal(res.statusCode, code, error);
      assert.equal(res.body.error, error);
    }
  } finally {
    console.error = quiet;
  }
});

test('missing API key answers 500 without calling Anthropic', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  mockFetch(() => { throw new Error('must not be called'); });
  const res = makeRes();
  await handler(makeReq(), res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, 'not_configured');
  assert.equal(calls.length, 0);
});
