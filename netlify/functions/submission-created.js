// Triggered automatically by Netlify on every form submission.
// Env vars required:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  — Telegram notifications
//   AMO_CLIENT_ID, AMO_CLIENT_SECRET      — amoCRM OAuth app credentials
//   AMO_REFRESH_TOKEN                     — initial refresh token (seed for Blobs)
//   AMO_DOMAIN                            — e.g. i2club.amocrm.ru

const { getStore } = require('@netlify/blobs');

const AMO_DOMAIN    = process.env.AMO_DOMAIN    || 'i2club.amocrm.ru';
const CLIENT_ID     = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI  = 'https://neon-quokka-6e2125.netlify.app/';

const LEVEL_NAMES = [
  'Уровень 0. Одиночка (0–6)',
  'Уровень 1. Стихия (7–13)',
  'Уровень 2. Островки (14–18)',
  'Уровень 3. AI-готовая команда (19–22)',
];

// ── amoCRM helpers ────────────────────────────────────────────────

async function refreshTokens(refreshToken) {
  const res = await fetch(`https://${AMO_DOMAIN}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      redirect_uri:  REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error('amoCRM token refresh failed: ' + await res.text());
  return res.json();
}

async function getAccessToken(store) {
  const stored = await store.get('tokens', { type: 'json' }).catch(() => null);
  const seed   = stored?.refresh_token || process.env.AMO_REFRESH_TOKEN;
  if (!seed) throw new Error('No refresh token available');

  const fresh = await refreshTokens(seed);
  await store.set('tokens', JSON.stringify({
    access_token:  fresh.access_token,
    refresh_token: fresh.refresh_token,
  }));
  return fresh.access_token;
}

async function amoPost(path, body, token) {
  const res = await fetch(`https://${AMO_DOMAIN}/api/v4${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`amoCRM POST ${path} failed: ` + await res.text());
  return res.json();
}

function detectContactField(contact) {
  if (!contact) return null;
  if (contact.includes('@')) return { field_code: 'EMAIL', values: [{ value: contact, enum_code: 'WORK' }] };
  if (/[\d\+]/.test(contact))  return { field_code: 'PHONE', values: [{ value: contact, enum_code: 'WORK' }] };
  return null; // telegram or other — handled as note text
}

// ── Main handler ──────────────────────────────────────────────────

exports.handler = async function (event) {
  let payload;
  try { payload = JSON.parse(event.body); } catch {
    return { statusCode: 400, body: 'Bad payload' };
  }

  const { data = {} } = payload;
  const name      = data.name    || 'Аноним';
  const contact   = data.contact || '';
  const score     = data.score   || '—';
  const idx       = parseInt(data.level, 10);
  const levelName = isNaN(idx) ? (data['level-name'] || '—') : (LEVEL_NAMES[idx] || '—');

  // ── 1. Telegram ───────────────────────────────────────────────
  const tgToken  = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;
  if (tgToken && tgChatId) {
    const text = [
      '🎯 <b>Новый лид — AI-готовность команды</b>',
      '',
      `👤 Имя: ${name}`,
      `📱 Контакт: ${contact || '—'}`,
      `📊 Балл: ${score} / 22`,
      `🏷 Уровень: ${levelName}`,
    ].join('\n');

    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: tgChatId, text, parse_mode: 'HTML' }),
    }).catch(e => console.error('Telegram error:', e));
  }

  // ── 2. amoCRM ─────────────────────────────────────────────────
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('amoCRM credentials not set, skipping');
    return { statusCode: 200 };
  }

  try {
    const store       = getStore('amocrm');
    const accessToken = await getAccessToken(store);

    // Create contact
    const contactField = detectContactField(contact);
    const contactBody  = [{
      first_name: name,
      ...(contactField ? { custom_fields_values: [contactField] } : {}),
    }];
    const contactRes = await amoPost('/contacts', contactBody, accessToken);
    const contactId  = contactRes?._embedded?.contacts?.[0]?.id;

    // Create lead
    const leadName = `AI-готовность (${score}/22) — ${name}`;
    const leadBody = [{
      name: leadName,
      ...(contactId ? { _embedded: { contacts: [{ id: contactId }] } } : {}),
    }];
    const leadRes = await amoPost('/leads', leadBody, accessToken);
    const leadId  = leadRes?._embedded?.leads?.[0]?.id;

    // Add note with full details
    if (leadId) {
      const noteLines = [`Балл: ${score}/22`, levelName];
      if (contact && !contactField) noteLines.push(`Контакт: ${contact}`);
      await amoPost(`/leads/${leadId}/notes`, [{
        note_type: 'common',
        params: { text: noteLines.join('\n') },
      }], accessToken).catch(e => console.error('amoCRM note error:', e));
    }

    console.log(`amoCRM: contact ${contactId}, lead ${leadId}`);
  } catch (e) {
    console.error('amoCRM error:', e);
  }

  return { statusCode: 200 };
};
