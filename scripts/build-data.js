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
// Если Google не выгрузился (например, истёк токен), расход Google берём из прошлого data.json
const googleMissing = !fs.existsSync(path.join(rawDir, 'google-ads.json'));
const prevData = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'data', 'data.json'), 'utf8')); } catch (e) { return null; } })();
const meta = rawFile('meta-ads.json', { rows: [] });
const yandex = rawFile('yandex-direct.json', { rows: [] });
const bxLeads = rawFile('bitrix-leads.json', { rows: [] });
const bxSales = rawFile('bitrix-sales.json', { rows: [] });
const bxContacts = rawFile('bitrix-contacts.json', { rows: [] });
const bxHistory = rawFile('bitrix-history.json', { rows: [] });

const FIRST = settings.firstDate || '2026-06-01';
const ST = settings.stages || {};
const up = (s) => String(s || '').trim().toUpperCase();
const QUAL = up(ST.qualified || 'КВАЛИФИКАЦИЯ ПРОЙДЕНА');
const PAID = up(ST.paid || 'ОПЛАТА ПОЛУЧЕНА');
const NOT_CLEAN = (ST.notClean || ['СПАМ', 'ДУБЛЬ']).map(up);

const day = (s) => String(s || '').slice(0, 10);
const month = (s) => day(s).slice(0, 7);

// ---------- платформа по utm_source ----------
function platformOf(utmSource, u) {
  const s = String(utmSource || '').trim().toLowerCase();
  if (!s) return null;
  const med = String((u && u.medium) || '').trim().toLowerCase();
  // органика: поиск без рекламы, ИИ-ассистенты, переходы из соцсетей без рекламы
  if (med === 'organic' || med === 'ai-assistant' || med === 'social') return 'SEO';
  if (/(chatgpt|gemini|perplexity|copilot|claude\.ai|deepseek)/.test(s)) return 'SEO';
  // google.com без medium/campaign/content — это органика (SEO), а не реклама
  if (s === 'google.com' && u && !med && !String(u.campaign || '').trim() && !String(u.content || '').trim()) return 'SEO';
  if (['meta', 'ig', 'fb', 'facebook', 'instagram', 'landing_meta'].includes(s)) return 'Meta';
  if (['google', 'google.com', 'landing_google'].includes(s)) return 'Google';
  if (['yandex', 'ya', 'yandex.kz', 'yandex.ru'].includes(s)) return 'Яндекс';
  // метки вида google_invest, meta-invest, yandex_invest и т.п.
  if (/(^|[^a-z])(google|gads|adwords)/.test(s)) return 'Google';
  if (/(^|[^a-z])(meta|facebook|instagram|fb|ig)([^a-z]|$)/.test(s)) return 'Meta';
  if (/yandex|(^|[^a-z])ya([^a-z]|$)/.test(s)) return 'Яндекс';
  if (s.includes('satu')) return 'Satu';
  // прямые заходы, звонки с сайта, landing и прочее — это не канал, платформу не определяем
  return null;
}
const HAS_API = new Set(['Google', 'Meta']);
const NO_CAMPAIGN = '(всё вместе)';
const UNDEF = 'Не определено', REPEAT = 'Повторные клиенты';
const REAL = new Set(['Google', 'Meta', 'Яндекс', 'Satu', 'SEO']);

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
  const st = siteOfText(name);
  siteIdx[platform][String(id)] = st; siteIdx[platform][String(name || '').toLowerCase()] = st;
  if (st) { const fk = platform + '|' + fam; (famSites[fk] = famSites[fk] || new Set()).add(st); }
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

// ---------- сайт: site (zenith-i) / lp / invest ----------
// По названию кампании или по UTM. Порядок важен: сначала invest, потом лендинг, потом сайт.
const siteOfText = (txt) => {
  const s = String(txt || '').toLowerCase();
  if (/инвест|invest/.test(s)) return 'invest';
  if (/лендинг|ленд|land|(^|[^a-z])lp([^a-z]|$)/.test(s)) return 'lp';
  if (/сайт|site|zenith-i/.test(s)) return 'site';
  return '';
};
const siteIdx = { Google: {}, Meta: {} };
// какие сайты встречаются у кампаний кабинета внутри одного «семейства» (платформа|семейство -> Set)
const famSites = {};
function leadSite(x, platform) {
  const u = x.utm || {};
  const direct = siteOfText([u.source, u.medium, u.campaign, u.content].join(' '));
  if (direct) return direct;
  const idx = siteIdx[platform];
  const c = String(u.campaign || '').trim();
  const byCab = idx ? (idx[c] || idx[c.toLowerCase()] || '') : '';
  if (byCab) return byCab;
  // метка распознана как семейство кампаний, и у всех кампаний этого семейства в кабинете один и тот же сайт
  const fs = famSites[platform + '|' + x.family];
  return fs && fs.size === 1 ? [...fs][0] : '';
}

// ---------- копилка строк ----------
const rows = new Map();
function bucket(d, p, c, s = '') {
  if (!s && p === 'Яндекс') s = 'site'; // вся реклама Яндекса идёт на zenith-i
  if (!s && p === 'Meta') s = 'lp'; // Мета без явного признака сайта — это LP
  const k = d + '|' + p + '|' + c + '|' + s;
  let r = rows.get(k);
  if (!r) {
    r = { d, p, c, s, sp: 0, spn: 0, usd: 0, cl: 0, im: 0, cv: 0, l: 0, cn: 0, q: 0, pay: 0, rev: 0 };
    rows.set(k, r);
  }
  return r;
}

// ---------- курс ----------
const rates = settings.usdToKzt || {};
const rateFor = (d) => Number(rates[month(d)] || rates.default || 500);

// ---------- комиссии и НДС при пополнении ----------
// В кабинете расход показан без комиссии и НДС. Реально мы платим больше:
// множитель = (1 + комиссия) * (1 + НДС). sp = с комиссиями, spn = как в кабинете.
const comm = settings.commission || {};
const factor = (p) => { const c = comm[p]; return c ? (1 + (c.fee || 0)) * (1 + (c.vat || 0)) : 1; };

// ---------- расход: Google и Meta ----------
// Сначала пробегаем по всем кабинетным строкам, чтобы заполнить индекс id/имя → семейство
google.rows.forEach((r) => cabinetFamily('Google', r.campaignId, r.campaignName));
meta.rows.forEach((r) => cabinetFamily('Meta', r.campaignId, r.campaignName));

const exclude = (settings.excludeCampaignKeywords || []).map((k) => k.toLowerCase());
const excluded = (name) => exclude.some((k) => String(name || '').toLowerCase().includes(k));

google.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const b = bucket(r.date, 'Google', cabinetFamily('Google', r.campaignId, r.campaignName), siteOfText(r.campaignName));
  const net = r.costUsd * rateFor(r.date);
  b.usd += r.costUsd; b.spn += net; b.sp += net * factor('Google');
  b.cl += r.clicks; b.im += r.impressions; b.cv += r.conversions;
});
let googleStale = false;
if (googleMissing && prevData) {
  googleStale = true;
  prevData.rows.filter((r) => r.p === 'Google' && (r.sp || r.usd)).forEach((r) => {
    const b = bucket(r.d, 'Google', r.c, r.s !== undefined ? r.s : siteOfText(r.c));
    b.sp += r.sp; b.spn += r.spn || 0; b.usd += r.usd || 0; b.cl += r.cl; b.im += r.im; b.cv += r.cv;
  });
}
meta.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const b = bucket(r.date, 'Meta', cabinetFamily('Meta', r.campaignId, r.campaignName), siteOfText(r.campaignName));
  const net = r.spendUsd * rateFor(r.date);
  b.usd += r.spendUsd; b.spn += net; b.sp += net * factor('Meta');
  b.cl += r.clicks; b.im += r.impressions; b.cv += r.leads;
});

// ---------- расход Яндекс.Директа (из API, в тенге; без НДС) ----------
// Если за месяц есть данные из API, ручной ввод за этот месяц не используется.
const yandexMonths = new Set();
yandex.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const b = bucket(r.date, 'Яндекс', NO_CAMPAIGN);
  b.spn += r.cost; b.sp += r.cost * factor('Яндекс');
  b.cl += r.clicks; b.im += r.impressions;
  yandexMonths.add(month(r.date));
});

// кампании кабинета, в названии которых нет признака сайта (для диагностики)
const noSite = {};
[['Google', google.rows, (r) => r.costUsd], ['Meta', meta.rows, (r) => r.spendUsd]].forEach(([p, arr, usd]) => arr.forEach((r) => {
  if (r.date < FIRST || siteOfText(r.campaignName)) return;
  const k = p + ' | ' + r.campaignName;
  noSite[k] = (noSite[k] || 0) + usd(r) * rateFor(r.date) * factor(p);
}));

// ---------- ручной расход (Satu, Яндекс и др.) ----------
const today = new Date().toISOString().slice(0, 10);
const manualAll = JSON.parse(JSON.stringify(settings.manualSpendKzt || {}));
Object.entries(settings.recurringSpendKzt || {}).forEach(([p, amt]) => {
  manualAll[p] = manualAll[p] || {};
  const [fy, fm] = FIRST.slice(0, 7).split('-').map(Number);
  const [ty, tm] = today.slice(0, 7).split('-').map(Number);
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, m = 1) : m++) {
    const ym = y + '-' + String(m).padStart(2, '0');
    if (manualAll[p][ym] === undefined) manualAll[p][ym] = amt;
  }
});
Object.entries(manualAll).forEach(([platform, byMonth]) => {
  Object.entries(byMonth).forEach(([ym, total]) => {
    if (platform === 'Яндекс' && yandexMonths.has(ym)) return;
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    // для текущего месяца раскладываем только до сегодняшнего дня, чтобы не было «будущих» трат
    const perDay = total / daysInMonth;
    for (let i = 1; i <= daysInMonth; i++) {
      const d = `${ym}-${String(i).padStart(2, '0')}`;
      if (d < FIRST || d > today) continue;
      const mb = bucket(d, platform, NO_CAMPAIGN);
      mb.spn += perDay; mb.sp += perDay * factor(platform);
    }
  });
});

// ---------- лиды из «Обработки заявок» ----------
const leads = bxLeads.rows.map((x) => ({
  ...x,
  day: day(x.created),
  platform: platformOf(x.utm.source, x.utm),
}));

// ---------- клиент: ищем историю по контакту, телефону и компании ----------
// Ключи клиента: c<контакт>, p<телефон>, k<компания>. Контакт «0» (не указан) — не клиент, его игнорируем.
const okId = (v) => (v && String(v) !== '0' ? String(v) : null);
const ctCard = new Map(bxContacts.rows.map((c) => [String(c.id), c]));
const keysOf = (e) => {
  const ks = [];
  const cid = okId(e.contact);
  if (cid) { ks.push('c' + cid); const c = ctCard.get(cid); if (c) { (c.phones || []).forEach((p) => ks.push('p' + p)); if (c.company) ks.push('k' + c.company); } }
  const co = okId(e.company); if (co) ks.push('k' + co);
  return [...new Set(ks)];
};
const clientIdx = new Map();
const seenIds = new Set();
[...leads.map((e) => [e, 'лид']), ...bxSales.rows.map((e) => [e, 'продажа']), ...bxHistory.rows.map((e) => [e, 'история'])].forEach(([e, kind]) => {
  const id = String(e.id); if (seenIds.has(id)) return; seenIds.add(id);
  const it = { id, created: e.created, own: platformOf(e.utm.source, e.utm), utm: e.utm, kind, ref: e, paid: kind === 'продажа' && up(e.stage) === PAID };
  keysOf(e).forEach((k) => { if (!clientIdx.has(k)) clientIdx.set(k, []); clientIdx.get(k).push(it); });
});
// другие заявки и сделки этого же клиента
const itemsOf = (e) => {
  const m = new Map();
  keysOf(e).forEach((k) => (clientIdx.get(k) || []).forEach((it) => m.set(it.id, it)));
  return [...m.values()].filter((it) => it.id !== String(e.id));
};
// повторный клиент: тип сделки «повторная», источник «существующий клиент» или у него уже была оплаченная сделка
const isRepeat = (e) => {
  if (/повтор/i.test(e.type || '')) return true;
  if (/существующ|повторн/i.test(e.sourceName || '')) return true;
  const c = ctCard.get(okId(e.contact) || '');
  if (c && /существующ|повторн/i.test(c.sourceName || '')) return true;
  const eDay = day(e.created);
  return itemsOf(e).some((it) => it.paid && day(it.ref.closed || it.ref.modified) < eDay);
};
const channelOf = (name) => {
  const n = String(name || '').toLowerCase();
  if (!n) return 'Источник не указан';
  if (/wapi|whatsapp|wazzup|ватсап|вацап/.test(n)) return 'WhatsApp';
  if (/звонок|call|телефон/.test(n)) return 'Звонок';
  if (/почт|mail/.test(n)) return 'Email';
  return name;
};

// ---------- лиды без UTM: определяем платформу по порядку ----------
// 1) у этого клиента РАНЬШЕ была заявка/сделка с понятной меткой -> берём её (контакт, телефон, компания)
// 2) UTM в карточке контакта
// 3) источник Битрикса «Satu» -> Satu
// 4) клиент уже покупал (повторная сделка) -> «Повторные клиенты»
// 5) остальное -> «Не определено» (страница заявки или источник Битрикса дают только подпись внутри)
const DIRS = [
  [/antikor|антикор/, 'Антикор'], [/gidroiz|гидроиз/, 'Гидроизоляция'], [/ognez|огнез/, 'Огнезащита'],
  [/rastvor|раствор/, 'Растворители'], [/poly|napoln|polimern|nalivn|наполь|пол(ы|ов)/, 'Напольные'],
  [/lkm|lakokras|laki-kraski|лкм|лакокрас/, 'ЛКМ'],
];
const dirOf = (t) => { const s = String(t || '').toLowerCase(); for (const [re, d] of DIRS) if (re.test(s)) return d; return ''; };
const pageOf = (x) => { const m = String(x.sdesc || '').match(/https?:\/\/[^\s,]+/); return m ? m[0] : ''; };
// страница заявки — самый надёжный признак, на какой площадке человек оставил заявку
const pageSiteOf = (x) => {
  const p = pageOf(x);
  if (!p) return '';
  let u;
  try { u = new URL(p); } catch (e) { return ''; }
  const h = u.hostname.toLowerCase();
  if (/^\/lp\//.test(u.pathname)) return 'lp';
  if (/(^|\.)zenith-invest\.kz$/.test(h)) return 'invest';
  if (/(^|\.)zenith-i\.kz$/.test(h)) return 'site';
  return '';
};
const pageFixes = [];
const noUtm = { total: 0, by: {}, sources: {}, pages: {} };
leads.forEach((x) => {
  if (x.platform) return;
  let a = null;
  const prior = itemsOf(x).filter((it) => it.own && REAL.has(it.own) && it.created <= x.created).sort((p, q) => (p.created < q.created ? 1 : -1))[0];
  if (prior) a = { platform: prior.own, utm: prior.utm, how: 'клиент: ранее была метка' };
  if (!a) {
    const c = ctCard.get(okId(x.contact) || '');
    const cp = c && platformOf(c.utm.source, c.utm);
    if (cp && REAL.has(cp)) a = { platform: cp, utm: c.utm, how: 'контакт: UTM в карточке' };
  }
  const page = pageOf(x);
  let path = '';
  try { path = page ? new URL(page).pathname : ''; } catch (e) { path = ''; }
  const dir = dirOf(path) || dirOf(x.title);
  if (!a && /satu/i.test(String(x.sourceName || ''))) a = { platform: 'Satu', how: 'источник Битрикса: Satu' };
  if (!a && isRepeat(x)) a = { platform: REPEAT, family: channelOf(x.sourceName || x.source), how: 'повторный клиент' };
  if (!a && /^\/lp\//.test(path)) a = { platform: UNDEF, family: 'Лендинг · ' + (dir || 'без направления'), how: 'лендинг без метки' };
  if (!a && page) a = { platform: UNDEF, family: 'Сайт · ' + (dir || 'прочие страницы'), how: 'страница сайта без метки' };
  if (!a) a = { platform: UNDEF, family: channelOf(x.sourceName || x.source), how: 'только источник Битрикса' };
  x.attr = a;
  if (x.day < FIRST) return;
  noUtm.total++;
  noUtm.by[a.how] = (noUtm.by[a.how] || 0) + 1;
  const sn = x.sourceName || x.source || '(пусто)';
  noUtm.sources[sn] = (noUtm.sources[sn] || 0) + 1;
  if (path) noUtm.pages[path] = (noUtm.pages[path] || 0) + 1;
});

const stagesLeads = {};
const utmSources = {};
const utmShare = {};
const qualList = [];
let leadsCounted = 0, leadsWithUtm = 0, cleanTotal = 0, qualTotal = 0;

leads.forEach((x) => {
  stagesLeads[x.stage] = (stagesLeads[x.stage] || 0) + 1;
  if (x.day < FIRST) return;
  const st = up(x.stage);
  const clean = !NOT_CLEAN.includes(st);
  const qual = st === QUAL;
  // ручные правки по конкретным сделкам: settings.json -> leadOverrides { "id сделки": { site, family, platform } }
  const ov = (settings.leadOverrides || {})[String(x.id)] || {};
  const a = x.attr;
  const platform = ov.platform || x.platform || (a && a.platform) || UNDEF;
  let camp;
  if (x.platform) camp = utmFamily(x.platform, x.utm.campaign);
  else if (a && a.utm) camp = utmFamily(a.platform, a.utm.campaign);
  else if (a && a.family) camp = a.family;
  else camp = NO_CAMPAIGN;
  let campOut = ov.family || camp;
  x.eff = platform;
  x.site = ov.site || (x.platform ? leadSite(x, x.platform) : a && a.utm ? leadSite({ ...x, utm: a.utm }, a.platform) : (a && a.site) || '');
  // сверяем с реальной страницей заявки: «Ленд» только если заявка с /lp/, иначе «Сайт»; площадка — по домену
  if (x.platform && (platform === 'Google' || platform === 'Meta')) {
    const ps = pageSiteOf(x);
    if (ps) {
      const was = [campOut, x.site];
      if (!ov.site) x.site = ps;
      if (!ov.family) {
        const m = /^(.+) — (Ленд|Сайт)$/.exec(campOut);
        const want = ps === 'lp' ? 'Ленд' : 'Сайт';
        if (m && m[2] !== want) campOut = m[1] + ' — ' + want;
      }
      if (was[0] !== campOut || was[1] !== x.site) pageFixes.push({ id: x.id, p: platform, from: was.join(' | '), to: campOut + ' | ' + x.site, page: pageOf(x) });
    }
  }
  x.family = campOut;
  const b = bucket(x.day, platform, campOut, x.site);
  b.l += 1;
  if (clean) b.cn += 1;
  if (qual) { b.q += 1; qualList.push({ id: x.id, d: x.day, s: b.s, p: platform, c: campOut }); }

  leadsCounted++; if (x.platform) leadsWithUtm++;
  if (clean) cleanTotal++; if (qual) qualTotal++;
  const m = month(x.day);
  utmShare[m] = utmShare[m] || { leads: 0, withUtm: 0 };
  utmShare[m].leads++; if (x.platform) utmShare[m].withUtm++;
  const sk = (x.utm.source || '(пусто)').toLowerCase();
  utmSources[sk] = utmSources[sk] || { n: 0, platform: x.platform || UNDEF };
  utmSources[sk].n++;
});

// ---------- оплаты из «Первичных продаж» ----------
const byContact = new Map();
leads.forEach((x) => {
  const ep = x.eff || x.platform;
  if (!x.contact || !ep || !REAL.has(ep)) return;
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
const payList = [];
const unknownPays = [];
const contactById = ctCard;
const histSrc = new Map();
bxHistory.rows.forEach((x) => { if (x.contact && x.sourceName && !histSrc.has(String(x.contact))) histSrc.set(String(x.contact), x.sourceName); });
const allByContact = new Map();
leads.forEach((x) => { if (!x.contact) return; if (!allByContact.has(x.contact)) allByContact.set(x.contact, []); allByContact.get(x.contact).push(x); });
const pay = { total: 0, viaContact: 0, viaOwnUtm: 0, viaHistory: 0, viaContactUtm: 0, unknown: 0, noContact: 0 };

bxSales.rows.forEach((s) => {
  stagesSales[s.stage] = (stagesSales[s.stage] || 0) + 1;
  if (up(s.stage) !== PAID) return;
  const payDay = day(s.closed) || day(s.modified);
  if (!payDay || payDay < FIRST) return;
  pay.total++;

  let platform = null, camp = NO_CAMPAIGN, site = '';
  const cands = s.contact ? byContact.get(s.contact) : null;
  if (!s.contact) pay.noContact++;
  if (cands && cands.length) {
    const limit = plusOneDay(s.created);
    const first = cands.find((x) => x.day <= limit) || null;
    if (first) { platform = first.eff || first.platform; camp = first.family || utmFamily(first.platform, first.utm.campaign); site = first.site || ''; pay.viaContact++; }
  }
  if (!platform) {
    const own = platformOf(s.utm.source, s.utm);
    if (own) { platform = own; camp = utmFamily(own, s.utm.campaign); site = leadSite(s, own); pay.viaOwnUtm++; }
  }
  if (!platform) {
    // у клиента (контакт, телефон, компания) раньше была заявка или сделка с понятной меткой -> первая из них
    const pool = itemsOf(s).filter((it) => it.own && REAL.has(it.own) && day(it.created) <= payDay).sort((a, b) => (a.created < b.created ? -1 : 1));
    if (pool.length) {
      const h = pool[0];
      platform = h.own; camp = h.ref.family || utmFamily(h.own, h.utm.campaign);
      site = h.ref.site !== undefined ? h.ref.site : leadSite(h.ref, h.own); pay.viaHistory++;
    }
  }
  if (!platform) {
    // собственные UTM в карточке контакта
    const c = contactById.get(okId(s.contact) || '');
    const cp = c && platformOf(c.utm.source, c.utm);
    if (cp && REAL.has(cp)) { platform = cp; camp = utmFamily(cp, c.utm.campaign); site = leadSite(c, cp); pay.viaContactUtm++; }
  }
  if (!platform && /satu/i.test(String(s.sourceName || ''))) platform = 'Satu';
  if (!platform) {
    // метки нигде нет: повторный клиент или не определено; внутри показываем канал (источник сделки, заявки или контакта)
    const c = contactById.get(okId(s.contact) || '');
    const ls = allByContact.get(s.contact) || [];
    const srcName = s.sourceName || (ls.find((x) => x.sourceName) || {}).sourceName || (c && c.sourceName) || histSrc.get(String(s.contact)) || '';
    platform = isRepeat(s) ? REPEAT : UNDEF; camp = channelOf(srcName); pay.unknown++;
    if (payDay >= '2026-10-15') unknownPays.push({ id: s.id, created: s.created, paid: payDay, amount: Math.round(s.amount), platform, contact: s.contact, utm: s.utm });
  }
  if (REAL.has(platform) && !HAS_API.has(platform)) camp = NO_CAMPAIGN;

  const b = bucket(payDay, platform, camp, site);
  b.pay += 1; b.rev += s.amount;
  payList.push({ id: s.id, d: payDay, s: b.s, p: platform, c: camp, a: Math.round(s.amount) });
});

// ---------- итог ----------
const round = (n) => Math.round(n * 100) / 100;
const outRows = [...rows.values()]
  .map((r) => ({ ...r, sp: round(r.sp), spn: round(r.spn), usd: round(r.usd), cv: round(r.cv), rev: round(r.rev) }))
  .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.p < b.p ? -1 : 1));

const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ k, n: v }));

const debug = (settings.debugDeals || []).map(String).map((id) => {
  const x = leads.find((l) => String(l.id) === id);
  const s = bxSales.rows.find((r) => String(r.id) === id);
  const e = x || s;
  if (!e) return { id, found: false };
  const cid = e.contact;
  return {
    id, kind: x ? 'лид' : 'продажа', stage: e.stage, created: e.created, utm: e.utm, source: e.sourceName, sdesc: e.sdesc || '',
    platformOwn: x ? x.platform : platformOf(e.utm.source, e.utm), attr: x && x.attr ? { platform: x.attr.platform, how: x.attr.how } : null, eff: x ? x.eff : null,
    contact: cid, company: e.company,
    sameContact: (allByContact.get(cid) || []).filter((y) => String(y.id) !== id).map((y) => ({ id: y.id, created: y.created, stage: y.stage, utm: y.utm, platform: y.platform })),
    hist: itemsOf(e).map((h) => ({ id: h.id, own: h.own, created: h.created, kind: h.kind })),
  };
});

const output = {
  generatedAt: new Date().toISOString(),
  firstDate: FIRST,
  rates,
  commission: comm,
  portal: settings.bitrixPortal || 'macron.bitrix24.kz',
  rows: outRows,
  pays: payList.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : Number(b.id) - Number(a.id))),
  quals: qualList.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : Number(b.id) - Number(a.id))),
  diagnostics: {
    googleStale,
    debug,
    unknownPays,
    noSiteCampaigns: Object.entries(noSite).map(([k, v]) => ({ k, sp: Math.round(v) })).sort((a, b) => b.sp - a.sp).slice(0, 40),
    leads: { total: leadsCounted, withUtm: leadsWithUtm, clean: cleanTotal, qualified: qualTotal },
    utmShareByMonth: utmShare,
    payments: pay,
    stagesLeads,
    stagesSales,
    utmSources,
    unmatchedUtm: top(unmatchedUtm, 30),
    pageFixes,
    noUtm: { total: noUtm.total, by: top(noUtm.by, 10), sources: top(noUtm.sources, 20), pages: top(noUtm.pages, 25) },
    unmatchedCabinet: top(unmatchedCabinet, 30),
    fetchedAt: { google: google.fetchedAt || null, meta: meta.fetchedAt || null, yandex: yandex.fetchedAt || null, bitrix: bxLeads.fetchedAt || null },
  },
};

fs.writeFileSync(path.join(root, 'data', 'data.json'), JSON.stringify(output));
console.log(`data.json: ${outRows.length} строк | лидов ${leadsCounted} (с меткой ${leadsWithUtm}), квалов ${qualTotal}, оплат ${pay.total} ` +
  `(через контакт ${pay.viaContact}, по своей метке ${pay.viaOwnUtm}, не определено ${pay.unknown})`);
