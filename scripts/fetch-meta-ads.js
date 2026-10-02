// Забирает из Meta (Facebook/Instagram) расход, клики, показы и лиды по дням
// и по кампаниям. Результат: data/raw/meta-ads.json
//
// Секреты: META_ACCESS_TOKEN (токен системного пользователя, право ads_read),
//          META_AD_ACCOUNT_ID (вида act_1234567890; если цифры без act_ — добавим сами)

const { readJson, writeRaw, need, sleep } = require('./lib');

const API = 'https://graph.facebook.com/v21.0';
const LEAD_TYPES = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.messaging_first_reply',
];

function pickLeads(actions) {
  if (!Array.isArray(actions)) return 0;
  for (const t of LEAD_TYPES) {
    const a = actions.find((x) => x.action_type === t);
    if (a) return Number(a.value || 0);
  }
  return 0;
}

async function getJson(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(url);
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error(`Meta: не JSON (HTTP ${r.status}): ${text.slice(0, 300)}`); }
    if (r.ok) return d;
    // 17/4/32/613 — лимиты запросов, пробуем ещё раз
    if (d.error && [4, 17, 32, 613].includes(d.error.code) && attempt < 3) { await sleep(20000 * attempt); continue; }
    throw new Error('Meta API error: ' + JSON.stringify(d.error || d).slice(0, 1000));
  }
}

async function main() {
  need(['META_ACCESS_TOKEN', 'META_AD_ACCOUNT_ID']);
  let acc = String(process.env.META_AD_ACCOUNT_ID).trim();
  if (!acc.startsWith('act_')) acc = 'act_' + acc;

  const settings = readJson('config/settings.json', {});
  const from = settings.firstDate || '2026-06-01';
  const to = new Date().toISOString().slice(0, 10);

  const params = new URLSearchParams({
    access_token: process.env.META_ACCESS_TOKEN,
    level: 'campaign',
    time_increment: '1',
    time_range: JSON.stringify({ since: from, until: to }),
    fields: 'campaign_id,campaign_name,spend,clicks,impressions,actions',
    limit: '500',
  });
  let url = `${API}/${acc}/insights?${params}`;
  const rows = [];
  while (url) {
    const d = await getJson(url);
    (d.data || []).forEach((x) => rows.push({
      date: x.date_start,
      campaignId: String(x.campaign_id),
      campaignName: x.campaign_name,
      spendUsd: Number(x.spend || 0),
      clicks: Number(x.clicks || 0),
      impressions: Number(x.impressions || 0),
      leads: pickLeads(x.actions),
    }));
    url = d.paging && d.paging.next ? d.paging.next : null;
  }

  writeRaw('meta-ads.json', { fetchedAt: new Date().toISOString(), from, to, rows });
  console.log(`Meta Ads: ${rows.length} строк, ${new Set(rows.map((r) => r.campaignId)).size} кампаний, ${from}..${to}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
