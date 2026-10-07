const encoder = new TextEncoder();
const MODE_KEYS = new Set(['cold-spell', 'morning-summary', 'before-period']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/vapid-public-key' && request.method === 'GET') {
      return json({ publicKey: env.VAPID_PUBLIC_KEY || '' }, 200, cors);
    }

    if (url.pathname === '/api/subscriptions' && request.method === 'POST') {
      return createSubscription(request, env, cors);
    }

    const match = url.pathname.match(/^\/api\/subscriptions\/([\w-]+)$/);
    if (match && request.method === 'PUT') {
      return updateSubscription(request, env, cors, match[1]);
    }
    if (match && request.method === 'DELETE') {
      return deleteSubscription(request, env, cors, match[1]);
    }

    return json({ error: 'Not found' }, 404, cors);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkForecasts(env));
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = (env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '*').split(',').map(value => value.trim());
  const allowAnyOrigin = allowedOrigins.includes('*');
  return {
    'Access-Control-Allow-Origin': allowAnyOrigin ? '*' : (allowedOrigins.includes(origin) ? origin : 'null'),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(value, status, cors) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function createSubscription(request, env, cors) {
  const body = await readJson(request);
  if (!body || !validId(body.id) || !validToken(body.token) || !validConfig(body.config) || !validSubscription(body.subscription)) {
    return json({ error: 'Invalid subscription details' }, 400, cors);
  }

  const tokenHash = await hashToken(body.token);
  await env.DB.prepare(`
    INSERT INTO subscriptions (
      id, token_hash, subscription_json, latitude, longitude, place, timezone,
      threshold_c, modes_json, last_cold_spell_key, last_summary_date,
      sent_periods_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(
    body.id,
    tokenHash,
    JSON.stringify(body.subscription),
    body.config.latitude,
    body.config.longitude,
    body.config.place.slice(0, 100),
    body.config.timezone,
    body.config.thresholdC,
    JSON.stringify(body.config.modes),
  ).run();

  return json({ ok: true }, 201, cors);
}

async function updateSubscription(request, env, cors, id) {
  const token = bearerToken(request);
  const body = await readJson(request);
  if (!token || !validConfig(body?.config) || !validSubscription(body?.subscription)) {
    return json({ error: 'Invalid subscription details' }, 400, cors);
  }

  const result = await env.DB.prepare(`
    UPDATE subscriptions SET subscription_json = ?, latitude = ?, longitude = ?,
      place = ?, timezone = ?, threshold_c = ?, modes_json = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND token_hash = ?
  `).bind(
    JSON.stringify(body.subscription),
    body.config.latitude,
    body.config.longitude,
    body.config.place.slice(0, 100),
    body.config.timezone,
    body.config.thresholdC,
    JSON.stringify(body.config.modes),
    id,
    await hashToken(token),
  ).run();

  return result.meta.changes ? json({ ok: true }, 200, cors) : json({ error: 'Subscription not found' }, 404, cors);
}

async function deleteSubscription(request, env, cors, id) {
  const token = bearerToken(request);
  if (!token) return json({ error: 'Unauthorized' }, 401, cors);

  const result = await env.DB.prepare('DELETE FROM subscriptions WHERE id = ? AND token_hash = ?')
    .bind(id, await hashToken(token)).run();
  return result.meta.changes ? json({ ok: true }, 200, cors) : json({ error: 'Subscription not found' }, 404, cors);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function validId(value) {
  return typeof value === 'string' && /^[\w-]{16,80}$/.test(value);
}

function validToken(value) {
  return typeof value === 'string' && /^[\w-]{32,100}$/.test(value);
}

function validSubscription(value) {
  return value && typeof value.endpoint === 'string' && value.endpoint.startsWith('https://') &&
    typeof value.keys?.p256dh === 'string' && typeof value.keys?.auth === 'string';
}

function validConfig(value) {
  return value && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 &&
    Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180 &&
    Number.isFinite(value.thresholdC) && value.thresholdC >= -50 && value.thresholdC <= 20 &&
    typeof value.place === 'string' && typeof value.timezone === 'string' &&
    Array.isArray(value.modes) && value.modes.length > 0 &&
    value.modes.every(mode => MODE_KEYS.has(mode));
}

function bearerToken(request) {
  const match = request.headers.get('Authorization')?.match(/^Bearer ([\w-]{32,100})$/);
  return match?.[1] || null;
}

async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return toBase64Url(new Uint8Array(digest));
}

async function checkForecasts(env) {
  const { results } = await env.DB.prepare('SELECT * FROM subscriptions').all();
  for (const row of results) {
    try {
      await checkSubscription(row, env);
    } catch (error) {
      console.error(`Forecast check failed for ${row.id}:`, error);
    }
  }
}

async function checkSubscription(row, env) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: row.latitude,
    longitude: row.longitude,
    hourly: 'temperature_2m',
    temperature_unit: 'celsius',
    timezone: 'UTC',
    past_days: '1',
    forecast_days: '2',
  });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
  const forecast = await response.json();
  const times = forecast.hourly?.time || [];
  const temperatures = forecast.hourly?.temperature_2m || [];
  if (!times.length || times.length !== temperatures.length) return;

  const now = Date.now();
  const modes = JSON.parse(row.modes_json);
  let lastColdSpellKey = row.last_cold_spell_key;
  let lastSummaryDate = row.last_summary_date;
  let sentPeriods = JSON.parse(row.sent_periods_json || '[]');

  if (modes.includes('cold-spell')) {
    const coldRun = findUpcomingColdRun(times, temperatures, row.threshold_c, now);
    if (coldRun && coldRun.key !== lastColdSpellKey) {
      await sendNotification(row, env, 'Freezing temperatures ahead', `${row.place}: temperatures are forecast at or below ${formatTemp(row.threshold_c)}°C. Drip your faucets to help protect pipes.`, coldRun.key);
      lastColdSpellKey = coldRun.key;
    }
  }

  if (modes.includes('morning-summary')) {
    const localNow = getLocalParts(new Date(now), row.timezone);
    const localDate = `${localNow.year}-${localNow.month}-${localNow.day}`;
    if (localNow.hour === '07' && Number(localNow.minute) < 15 && localDate !== lastSummaryDate) {
      const coldHours = times.reduce((count, time, index) => count + (Date.parse(time + 'Z') >= now && temperatures[index] <= row.threshold_c ? 1 : 0), 0);
      if (coldHours) {
        await sendNotification(row, env, 'DripCheck morning forecast', `${row.place}: at least one upcoming period may reach ${formatTemp(row.threshold_c)}°C or colder.`, localDate);
      }
      lastSummaryDate = localDate;
    }
  }

  if (modes.includes('before-period')) {
    const upcomingPeriods = coldPeriods(times, temperatures, row.threshold_c, row.timezone, now);
    for (const period of upcomingPeriods) {
      const minutesUntilStart = (period.start - now) / 60000;
      if (minutesUntilStart <= 0 || minutesUntilStart > 60 || sentPeriods.includes(period.key)) continue;
      await sendNotification(row, env, `Drip faucets ${period.label.toLowerCase()}`, `${row.place}: the ${period.label.toLowerCase()} forecast may reach ${formatTemp(period.low)}°C or colder.`, period.key);
      sentPeriods.push(period.key);
    }
    sentPeriods = sentPeriods.filter(key => Date.now() - Date.parse(key.slice(0, 24)) < 4 * 86400000);
  }

  await env.DB.prepare(`
    UPDATE subscriptions SET last_cold_spell_key = ?, last_summary_date = ?,
      sent_periods_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(lastColdSpellKey, lastSummaryDate, JSON.stringify(sentPeriods), row.id).run();
}

function findUpcomingColdRun(times, temperatures, threshold, now) {
  let runStart = null;
  let runEnd = null;
  for (let index = 0; index <= times.length; index++) {
    const timestamp = index < times.length ? Date.parse(times[index] + 'Z') : NaN;
    const isCold = index < times.length && temperatures[index] <= threshold;
    if (isCold) {
      if (runStart === null) runStart = timestamp;
      runEnd = timestamp;
    } else if (runStart !== null) {
      if (runEnd + 3600000 >= now) return { key: new Date(runStart).toISOString() };
      runStart = null;
      runEnd = null;
    }
  }
  return null;
}

function coldPeriods(times, temperatures, threshold, timezone, now) {
  const grouped = new Map();
  for (let index = 0; index < times.length; index++) {
    const timestamp = Date.parse(times[index] + 'Z');
    const parts = getLocalParts(new Date(timestamp), timezone);
    const hour = Number(parts.hour);
    const period = hour < 6 || hour >= 22 ? 'Overnight' : hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
    const periodDate = hour < 6
      ? getLocalParts(new Date(timestamp - (hour + 2) * 3600000), timezone)
      : parts;
    const key = `${periodDate.year}-${periodDate.month}-${periodDate.day}_${period}`;
    const startHour = period === 'Overnight' ? 22 : period === 'Morning' ? 6 : period === 'Afternoon' ? 12 : 18;
    const periodStart = zonedTimestamp(periodDate, startHour, timezone);
    const group = grouped.get(key) || { key: `${times[index]}Z_${period}`, label: period, start: periodStart, low: Infinity };
    if (temperatures[index] <= threshold) group.low = Math.min(group.low, temperatures[index]);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .filter(group => group.start !== null && group.start > now && group.start - now <= 60 * 60000 && Number.isFinite(group.low))
    .map(group => ({ ...group, key: `${new Date(group.start).toISOString()}_${group.label}` }));
}

function zonedTimestamp(dateParts, hour, timezone) {
  const desired = Date.UTC(Number(dateParts.year), Number(dateParts.month) - 1, Number(dateParts.day), hour);
  let timestamp = desired;
  for (let attempt = 0; attempt < 3; attempt++) {
    const local = getLocalParts(new Date(timestamp), timezone);
    const observed = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day), Number(local.hour), Number(local.minute));
    timestamp += desired - observed;
  }
  return timestamp;
}

function getLocalParts(date, timezone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
  }
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function formatTemp(value) {
  return String(Math.round(value));
}

async function sendNotification(row, env, title, body, tag) {
  const subscription = JSON.parse(row.subscription_json);
  const payload = await encryptPayload(subscription, JSON.stringify({ title, body, tag, url: '/' }));
  const vapid = await createVapidAuthorization(subscription.endpoint, env);
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': vapid,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
    },
    body: payload,
  });

  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare('DELETE FROM subscriptions WHERE id = ?').bind(row.id).run();
    return;
  }
  if (!response.ok) throw new Error(`Push service returned ${response.status}`);
}

async function encryptPayload(subscription, message) {
  const userPublicKey = fromBase64Url(subscription.keys.p256dh);
  const authSecret = fromBase64Url(subscription.keys.auth);
  if (userPublicKey.length !== 65 || authSecret.length !== 16) throw new Error('Invalid push encryption keys');

  const userKey = await crypto.subtle.importKey('raw', userPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const serverKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: userKey }, serverKeys.privateKey, 256));

  const keyInfo = concat(encoder.encode('WebPush: info\0'), userPublicKey, serverPublicKey);
  const inputKeyMaterial = await hkdf(authSecret, sharedSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, inputKeyMaterial);
  const contentKey = await hkdfExpand(prk, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, encoder.encode('Content-Encoding: nonce\0'), 12);
  const plaintext = concat(encoder.encode(message), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));

  const header = new Uint8Array(21 + serverPublicKey.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = serverPublicKey.length;
  header.set(serverPublicKey, 21);
  return concat(header, ciphertext);
}

async function hkdf(salt, inputKeyMaterial, info, length) {
  const prk = await hmac(salt, inputKeyMaterial);
  return hkdfExpand(prk, info, length);
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const output = new Uint8Array(length);
  let previous = new Uint8Array();
  let offset = 0;
  for (let counter = 1; offset < length; counter++) {
    previous = new Uint8Array(await crypto.subtle.sign('HMAC', key, concat(previous, info, new Uint8Array([counter]))));
    const chunk = previous.subarray(0, Math.min(previous.length, length - offset));
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function hmac(rawKey, data) {
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function createVapidAuthorization(endpoint, env) {
  const publicKey = fromBase64Url(env.VAPID_PUBLIC_KEY || '');
  const privateScalar = fromBase64Url(env.VAPID_PRIVATE_KEY || '');
  if (publicKey.length !== 65 || privateScalar.length !== 32) throw new Error('VAPID keys are not configured');

  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: toBase64Url(publicKey.subarray(1, 33)),
    y: toBase64Url(publicKey.subarray(33, 65)),
    d: toBase64Url(privateScalar),
    ext: true,
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const audience = new URL(endpoint).origin;
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: env.VAPID_SUBJECT || 'mailto:notifications@example.com',
  })));
  const unsignedToken = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsignedToken),
  ));
  return `vapid t=${unsignedToken}.${toBase64Url(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

function concat(...arrays) {
  const output = new Uint8Array(arrays.reduce((total, array) => total + array.length, 0));
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.length;
  }
  return output;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}