// Забирает из Google Ads расход, клики, показы и конверсии по дням и по
// кампаниям с даты firstDate (config/settings.json) по сегодня.
// Результат: data/raw/google-ads.json
//
// Секреты (GitHub → Settings → Secrets → Actions):
//   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
//   GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID (без дефисов),
//   GOOGLE_ADS_LOGIN_CUSTOMER_ID (id менеджерского аккаунта, можно пустым, если заходишь напрямую)

const { readJson, writeRaw, need } = require('./lib');

const API_VERSION = 'v24';
const E = process.env;

async function getAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: E.GOOGLE_ADS_CLIENT_ID,
      client_secret: E.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: E.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch { throw new Error(`Google OAuth: не JSON (HTTP ${r.status}): ${text.slice(0, 300)}`); }
  if (!r.ok) {
    const hint = d.error === 'invalid_grant'
      ? ' Скорее всего, refresh token протух: проверь, что OAuth consent screen в статусе "In production", и получи токен заново.'
      : '';
    throw new Error('Google OAuth error: ' + JSON.stringify(d) + hint);
  }
  return d.access_token;
}

async function runQuery(token, query) {
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${E.GOOGLE_ADS_CUSTOMER_ID}/googleAds:search`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'developer-token': E.GOOGLE_ADS_DEVELOPER_TOKEN,
  };
  if (E.GOOGLE_ADS_LOGIN_CUSTOMER_ID) headers['login-customer-id'] = E.GOOGLE_ADS_LOGIN_CUSTOMER_ID;

  const out = [];
  let pageToken;
  do {
    const body = { query, ...(pageToken ? { pageToken } : {}) };
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error(`Google Ads: не JSON (HTTP ${r.status}): ${text.slice(0, 300)}`); }
    if (!r.ok) throw new Error('Google Ads API error: ' + JSON.stringify(d).slice(0, 1200));
    (d.results || []).forEach((x) => out.push(x));
    pageToken = d.nextPageToken;
  } while (pageToken);
  return out;
}

async function main() {
  need(['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID']);
  const settings = readJson('config/settings.json', {});
  const from = settings.firstDate || '2026-06-01';
  const to = new Date().toISOString().slice(0, 10);

  const token = await getAccessToken();
  const q = `
    SELECT campaign.id, campaign.name, campaign.status,
           metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions,
           segments.date
    FROM campaign
    WHERE segments.date BETWEEN '${from}' AND '${to}'
      AND campaign.status != 'REMOVED'`;
  const res = await runQuery(token, q);

  const rows = res.map((x) => ({
    date: x.segments.date,
    campaignId: String(x.campaign.id),
    campaignName: x.campaign.name,
    costUsd: Number(x.metrics.costMicros || 0) / 1e6,
    clicks: Number(x.metrics.clicks || 0),
    impressions: Number(x.metrics.impressions || 0),
    conversions: Number(x.metrics.conversions || 0),
  })).filter((r) => r.costUsd > 0 || r.clicks > 0 || r.impressions > 0);

  writeRaw('google-ads.json', { fetchedAt: new Date().toISOString(), from, to, rows });
  console.log(`Google Ads: ${rows.length} строк, ${new Set(rows.map((r) => r.campaignId)).size} кампаний, ${from}..${to}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
