// Сводит расход из рекламных кабинетов и сделки из Битрикс24 в один файл
// data/data.json, который читает дашборд (index.html).
//
// В data.json лежат ТОЛЬКО агрегаты по дням/кампаниям: без телефонов, имён
// и id клиентов. Сырые выгрузки (data/raw) в репозиторий не попадают.

const fs = require('fs');
const path = require('path');
const { root, rawDir, readJson } = require('./lib');

const settings = readJson('config/settings.json', {});
const maps = readJson('config/campaign-map.json', {});

const rawFile = (n, fb) => {
  const p = path.join(rawDir, n);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fb;
};

const google = rawFile('google-ads.json', { rows: [] });
const meta = rawFile('meta-ads.json', { rows: [] });
const bxLeads = rawFile('bitrix-leads.json', { rows: [] });
const bxSales = rawFile('bitrix-sales.json', { rows: [] });

const FIRST = settings.firstDate || '2026-06-01';
const ST = settings.stages || {};
const up = (s) => String(s || '').trim().toUpperCase();
const QUAL = up(ST.qualified || 'КВАЛИФИКАЦИЯ ПРОЙДЕНА');
const PAID = up(ST.paid || 'ОПЛАТА ПОЛУЧЕНА');
const NOT_CLEAN = (ST.notClean || ['СПАМ', 'ДУБЛЬ']).map(up);

const day = (s) => String(s || '').slice(0, 10);
const month = (s) => day(s).slice(0, 7);

// ---------- платформа по utm_source ----------
function platformOf(utmSource) {
  const s = String(utmSource || '').trim().toLowerCase();
  if (!s) return null;
  if (['meta', 'ig', 'fb', 'facebook', 'instagram', 'landing_meta'].includes(s)) return 'Meta';
  if (['google', 'google.com', 'landing_google'].includes(s)) return 'Google';
  if (['yandex', 'ya', 'yandex.kz', 'yandex.ru'].includes(s)) return 'Яндекс';
  if (s.includes('satu')) return 'Satu';
  if (s.includes('zenith-i')) return 'Сайт (прямой)';
  return 'Другое';
}
const HAS_API = new Set(['Google', 'Meta']);
const NO_CAMPAIGN = '(всё вместе)';

// ---------- семейства кампаний ----------
function matchFamily(platformKey, text) {
  const t = String(text || '').toLowerCase();
  for (const rule of maps[platformKey] || []) {
    if (rule.match.some((group) => group.every((w) => t.includes(w.toLowerCase())))) return rule.family;
  }
  return null;
}

const cabinetIndex = { Google: { id: {}, name: {} }, Meta: { id: {}, name: {} } };
const unmatchedCabinet = {};

function cabinetFamily(platform, id, name) {
  const key = platform.toLowerCase();
  const fam = matchFamily(key, name) || name || `(кампания ${id})`;
  if (!matchFamily(key, name)) unmatchedCabinet[platform + ' | ' + name] = (unmatchedCabinet[platform + ' | ' + name] || 0) + 1;
  cabinetIndex[platform].id[String(id)] = fam;
  cabinetIndex[platform].name[String(name || '').toLowerCase()] = fam;
  return fam;
}

const unmatchedUtm = {};
function utmFamily(platform, utmCampaign) {
  if (!HAS_API.has(platform)) return NO_CAMPAIGN;
  const raw = String(utmCampaign || '').trim();
  if (!raw) return '(без названия кампании)';
  const idx = cabinetIndex[platform];
  const low = raw.toLowerCase();
  if (idx.id[raw]) return idx.id[raw];
  if (idx.name[low]) return idx.name[low];
  const byRule = matchFamily(platform.toLowerCase(), raw);
  if (byRule) return byRule;
  const k = platform + ' | ' + raw;
  unmatchedUtm[k] = (unmatchedUtm[k] || 0) + 1;
  return /^\d+$/.test(raw) ? '(метка-id, не найден в кабинете)' : '(метка не распознана)';
}

// ---------- копилка строк ----------
const rows = new Map();
function bucket(d, p, c) {
  const k = d + '|' + p + '|' + c;
  let r = rows.get(k);
  if (!r) {
    r = { d, p, c, sp: 0, usd: 0, cl: 0, im: 0, cv: 0, l: 0, cn: 0, q: 0, pay: 0, rev: 0 };
    rows.set(k, r);
  }
  return r;
}

// ---------- курс ----------
const rates = settings.usdToKzt || {};
const rateFor = (d) => Number(rates[month(d)] || rates.default || 500);

// ---------- расход: Google и Meta ----------
// Сначала пробегаем по всем кабинетным строкам, чтобы заполнить индекс id/имя → семейство
google.rows.forEach((r) => cabinetFamily('Google', r.campaignId, r.campaignName));
meta.rows.forEach((r) => cabinetFamily('Meta', r.campaignId, r.campaignName));

const exclude = (settings.excludeCampaignKeywords || []).map((k) => k.toLowerCase());
const excluded = (name) => exclude.some((k) => String(name || '').toLowerCase().includes(k));

google.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const b = bucket(r.date, 'Google', cabinetFamily('Google', r.campaignId, r.campaignName));
  b.usd += r.costUsd; b.sp += r.costUsd * rateFor(r.date);
  b.cl += r.clicks; b.im += r.impressions; b.cv += r.conversions;
});
meta.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const b = bucket(r.date, 'Meta', cabinetFamily('Meta', r.campaignId, r.campaignName));
  b.usd += r.spendUsd; b.sp += r.spendUsd * rateFor(r.date);
  b.cl += r.clicks; b.im += r.impressions; b.cv += r.leads;
});

// ---------- ручной расход (Satu, Яндекс и др.) ----------
const today = new Date().toISOString().slice(0, 10);
Object.entries(settings.manualSpendKzt || {}).forEach(([platform, byMonth]) => {
  Object.entries(byMonth).forEach(([ym, total]) => {
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // для текущего месяца раскладываем только до сегодняшнего дня, чтобы не было «будущих» трат
    const perDay = total / daysInMonth;
    for (let i = 1; i <= daysInMonth; i++) {
      const d = `${ym}-${String(i).padStart(2, '0')}`;
      if (d < FIRST || d > today) continue;
      bucket(d, platform, NO_CAMPAIGN).sp += perDay;
    }
  });
});

// ---------- лиды из «Обработки заявок» ----------
const leads = bxLeads.rows.map((x) => ({
  ...x,
  day: day(x.created),
  platform: platformOf(x.utm.source),
}));
const stagesLeads = {};
const utmSources = {};
const utmShare = {};
let leadsCounted = 0, leadsWithUtm = 0, cleanTotal = 0, qualTotal = 0;

leads.forEach((x) => {
  stagesLeads[x.stage] = (stagesLeads[x.stage] || 0) + 1;
  if (x.day < FIRST) return;
  const st = up(x.stage);
  const clean = !NOT_CLEAN.includes(st);
  const qual = st === QUAL;
  const platform = x.platform || 'Без метки';
  const camp = x.platform ? utmFamily(x.platform, x.utm.campaign) : NO_CAMPAIGN;
  x.family = camp;
  const b = bucket(x.day, platform, platform === 'Без метки' ? NO_CAMPAIGN : camp);
  b.l += 1;
  if (clean) b.cn += 1;
  if (qual) b.q += 1;

  leadsCounted++; if (x.platform) leadsWithUtm++;
  if (clean) cleanTotal++; if (qual) qualTotal++;
  const m = month(x.day);
  utmShare[m] = utmShare[m] || { leads: 0, withUtm: 0 };
  utmShare[m].leads++; if (x.platform) utmShare[m].withUtm++;
  const sk = (x.utm.source || '(пусто)').toLowerCase();
  utmSources[sk] = utmSources[sk] || { n: 0, platform: x.platform || 'Без метки' };
  utmSources[sk].n++;
});

// ---------- оплаты из «Первичных продаж» ----------
const byContact = new Map();
leads.forEach((x) => {
  if (!x.contact || !x.platform) return;
  if (!byContact.has(x.contact)) byContact.set(x.contact, []);
  byContact.get(x.contact).push(x);
});
byContact.forEach((a) => a.sort((p, q) => (p.created < q.created ? -1 : 1)));

const plusOneDay = (iso) => {
  const d = new Date(day(iso) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

const stagesSales = {};
const pay = { total: 0, viaContact: 0, viaOwnUtm: 0, unknown: 0, noContact: 0 };

bxSales.rows.forEach((s) => {
  stagesSales[s.stage] = (stagesSales[s.stage] || 0) + 1;
  if (up(s.stage) !== PAID) return;
  const payDay = day(s.closed) || day(s.modified);
  if (!payDay || payDay < FIRST) return;
  pay.total++;

  let platform = null, camp = NO_CAMPAIGN;
  const cands = s.contact ? byContact.get(s.contact) : null;
  if (!s.contact) pay.noContact++;
  if (cands && cands.length) {
    const limit = plusOneDay(s.created);
    const first = cands.find((x) => x.day <= limit) || null;
    if (first) { platform = first.platform; camp = first.family || utmFamily(first.platform, first.utm.campaign); pay.viaContact++; }
  }
  if (!platform) {
    const own = platformOf(s.utm.source);
    if (own) { platform = own; camp = utmFamily(own, s.utm.campaign); pay.viaOwnUtm++; }
  }
  if (!platform) { platform = 'Без метки'; camp = NO_CAMPAIGN; pay.unknown++; }
  if (platform !== 'Без метки' && !HAS_API.has(platform)) camp = NO_CAMPAIGN;

  const b = bucket(payDay, platform, camp);
  b.pay += 1; b.rev += s.amount;
});

// ---------- итог ----------
const round = (n) => Math.round(n * 100) / 100;
const outRows = [...rows.values()]
  .map((r) => ({ ...r, sp: round(r.sp), usd: round(r.usd), cv: round(r.cv), rev: round(r.rev) }))
  .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.p < b.p ? -1 : 1));

const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, n: v }));

const output = {
  generatedAt: new Date().toISOString(),
  firstDate: FIRST,
  rates,
  rows: outRows,
  diagnostics: {
    leads: { total: leadsCounted, withUtm: leadsWithUtm, clean: cleanTotal, qualified: qualTotal },
    utmShareByMonth: utmShare,
    payments: pay,
    stagesLeads,
    stagesSales,
    utmSources,
    unmatchedUtm: top(unmatchedUtm, 30),
    unmatchedCabinet: top(unmatchedCabinet, 30),
    fetchedAt: { google: google.fetchedAt || null, meta: meta.fetchedAt || null, bitrix: bxLeads.fetchedAt || null },
  },
};

fs.writeFileSync(path.join(root, 'data', 'data.json'), JSON.stringify(output));
console.log(`data.json: ${outRows.length} строк | лидов ${leadsCounted} (с меткой ${leadsWithUtm}), квалов ${qualTotal}, оплат ${pay.total} ` +
  `(через контакт ${pay.viaContact}, по своей метке ${pay.viaOwnUtm}, не определено ${pay.unknown})`);
