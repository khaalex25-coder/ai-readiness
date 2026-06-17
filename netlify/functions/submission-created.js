// Triggered automatically by Netlify on every form submission.
// Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Netlify → Site settings → Environment variables.

exports.handler = async function (event) {
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad payload' };
  }

  const { data = {} } = payload;
  const name     = data.name         || '—';
  const contact  = data.contact      || '—';
  const score    = data.score        || '—';
  const idx      = parseInt(data.level, 10);
  const levelNames = [
    'Уровень 0. Одиночка (0–6)',
    'Уровень 1. Стихия (7–13)',
    'Уровень 2. Островки (14–18)',
    'Уровень 3. AI-готовая команда (19–22)',
  ];
  const levelName = isNaN(idx) ? (data['level-name'] || '—') : (levelNames[idx] || '—');

  const text = [
    '🎯 <b>Новый лид — AI-готовность команды</b>',
    '',
    `👤 Имя: ${name}`,
    `📱 Контакт: ${contact}`,
    `📊 Балл: ${score} / 22`,
    `🏷 Уровень: ${levelName}`,
  ].join('\n');

  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured');
    return { statusCode: 200 };
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });

  if (!res.ok) {
    console.error('Telegram API error:', await res.text());
  }

  return { statusCode: 200 };
};
