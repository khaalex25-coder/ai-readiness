// Triggered automatically by Netlify on every form submission.
// Env vars required:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  — Telegram notifications
//   AMO_CLIENT_ID, AMO_CLIENT_SECRET      — amoCRM OAuth app credentials
//   AMO_REFRESH_TOKEN                     — current refresh token (auto-updated after each use)
//   AMO_DOMAIN                            — e.g. i2club.amocrm.ru
//   NETLIFY_SITE_ID, NETLIFY_TOKEN        — for auto-updating AMO_REFRESH_TOKEN

const AMO_DOMAIN    = process.env.AMO_DOMAIN    || 'i2club.amocrm.ru';
const CLIENT_ID     = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI  = 'https://neon-quokka-6e2125.netlify.app/';
const SITE_ID       = process.env.NETLIFY_SITE_ID;
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

const LEVEL_NAMES = [
  'Уровень 0. Одиночка (0–6)',
  'Уровень 1. Стихия (7–13)',
  'Уровень 2. Островки (14–18)',
  'Уровень 3. AI-готовая команда (19–22)',
];

// ── amoCRM helpers ────────────────────────────────────────────────

async function getFreshAccessToken() {
  const refreshToken = process.env.AMO_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('AMO_REFRESH_TOKEN not set');

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
  const data = await res.json();

  // Save new refresh_token to Netlify env (fire-and-forget)
  if (SITE_ID && NETLIFY_TOKEN && data.refresh_token) {
    fetch(`https://api.netlify.com/api/v1/sites/${SITE_ID}/env/AMO_REFRESH_TOKEN`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: 'AMO_REFRESH_TOKEN',
        values: [{ context: 'all', value: data.refresh_token }],
      }),
    }).catch(e => console.error('Failed to update refresh token:', e));
  }

  return data.access_token;
}

async function amoPost(path, body, token) {
  const res = await fetch(`https://${AMO_DOMAIN}/api/v4${path}`, {
    method: 'POST',
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
  return null;
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
    const accessToken = await getFreshAccessToken();

    // Create contact
    const contactField = detectContactField(contact);
    const contactRes = await amoPost('/contacts', [{
      first_name: name,
      ...(contactField ? { custom_fields_values: [contactField] } : {}),
    }], accessToken);
    const contactId = contactRes?._embedded?.contacts?.[0]?.id;

    // Create lead
    const leadRes = await amoPost('/leads', [{
      name: `AI-готовность (${score}/22) — ${name}`,
      ...(contactId ? { _embedded: { contacts: [{ id: contactId }] } } : {}),
    }], accessToken);
    const leadId = leadRes?._embedded?.leads?.[0]?.id;

    // Add note
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
    console.error('amoCRM error:', e.message);
  }

  return { statusCode: 200 };
};
