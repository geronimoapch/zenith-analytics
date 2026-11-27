// Сводит расход из рекламных кабинетов и сделки из Битрикс24 в один файл
// data/data.json, который читает дашборд (index.html).
//
// В data.json лежат ТОЛЬКО агрегаты по дням/кампаниям: без телефонов, имён
// и id клиентов. Сырые выгрузки (data/raw) в репозиторий не попадают.
//
// Правила разметки лидов (согласованы 27.11.2026, подробно — в README и на странице дашборда).
// У каждого лида 4 поля:
//   Источник  — кто привёл (Google Ads, Meta Ads, SEO, Instagram, Без источника …)
//   Сайт      — где оставили заявку (zenith-invest / zenith-i / лендинг / неизвестно), только по фактам
//   Способ    — форма, калькулятор, квиз, звонок, WhatsApp, email
//   Направление — огнезащита, антикор, гидроизоляция, полы, ЛКМ …

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

// ================= ИСТОЧНИКИ =================
const S = {
  GOOGLE: 'Google Ads', META: 'Meta Ads', CHATGPT: 'ChatGPT Ads', YANDEX: 'Яндекс Директ',
  SEO: 'SEO', AI: 'ИИ-ассистенты', IG: 'Instagram', SATU: 'Satu',
  SITEUNK: 'Сайт, источник неизвестен', NONE: 'Без источника', REPEAT: 'Повторный клиент',
};
// источники, которые считаются «настоящими» (ими можно разметить клиента по истории)
const REAL = new Set([S.GOOGLE, S.META, S.CHATGPT, S.YANDEX, S.SEO, S.AI, S.IG, S.SATU]);
const API = { [S.GOOGLE]: 'google', [S.META]: 'meta' }; // ключи в campaign-map.json
const HAS_API = new Set(Object.keys(API));
// ключи комиссий и ручного расхода в settings.json -> источник
const COMM_KEY = { [S.GOOGLE]: 'Google', [S.META]: 'Meta', [S.YANDEX]: 'Яндекс', [S.SATU]: 'Satu', [S.CHATGPT]: 'ChatGPT' };
const MANUAL_SRC = { 'Яндекс': S.YANDEX, Satu: S.SATU, SEO: S.SEO, ChatGPT: S.CHATGPT, Google: S.GOOGLE, Meta: S.META };
const NO_CAMPAIGN = '(всё вместе)';

const unknownSources = {}; // utm_source, которые не подошли ни под одно правило: значение -> { n, ids }
const noteUnknown = (k, id) => { const o = (unknownSources[k] = unknownSources[k] || { n: 0, ids: [] }); o.n++; if (o.ids.length < 8 && id) o.ids.push(String(id)); };

// Источник по UTM. Возвращает { src, rule } или null, если меток нет.
function sourceOf(u, id) {
  const s = String((u && u.source) || '').trim().toLowerCase();
  if (!s || s === 'source not set' || s === '(not set)') return null;
  if (/^(test\d*|claude_test.*)$/.test(s)) return { src: S.SITEUNK, rule: 'тестовая метка' };
  if (s === 'landing' || s === 'lp') return { src: S.SITEUNK, rule: 'метка: лендинг без источника' };
  const med = String((u && u.medium) || '').trim().toLowerCase();
  const camp = String((u && u.campaign) || '').trim().toLowerCase();
  const cont = String((u && u.content) || '').trim().toLowerCase();
  const paid = /cpc|ppc|paid|ads|cpm/.test(med);
  if (/chatgpt_ads|openai_ads/.test(s) || (/chatgpt|openai/.test(s) && paid)) return { src: S.CHATGPT, rule: 'метка: реклама ChatGPT' };
  if (med === 'organic') return { src: S.SEO, rule: 'метка: органический поиск' };
  if (/(^|\.)(google|yandex|bing|duckduckgo|yahoo|mail)\.(com|kz|ru)$/.test(s) && !med && !camp && !cont) return { src: S.SEO, rule: 'метка: поисковик без кампании' };
  if (/(chatgpt|perplexity|gemini|copilot|claude\.ai|deepseek|openai)/.test(s)) return { src: S.AI, rule: 'метка: ИИ-ассистент' };
  if (/(^|[^a-z])(ig|instagram|facebook|fb|meta)([^a-z]|$)/.test(s) && (med === 'social' || cont === 'link_in_bio' || camp === 'bio')) return { src: S.IG, rule: 'метка: соцсети без рекламы' };
  if (/(^|[^a-z])(meta|facebook|instagram|fb|ig)([^a-z]|$)/.test(s) || s === 'landing_meta') return { src: S.META, rule: s === 'landing_meta' ? 'коллтрекинг: номер лендинга Meta' : 'метка: Meta' };
  if (/(^|[^a-z])(google|gads|adwords)/.test(s) || s === 'landing_google') return { src: S.GOOGLE, rule: s === 'landing_google' ? 'коллтрекинг: номер лендинга Google' : 'метка: Google' };
  if (/yandex|(^|[^a-z])ya([^a-z]|$)/.test(s)) return { src: S.YANDEX, rule: 'метка: Яндекс' };
  if (s.includes('satu')) return { src: S.SATU, rule: 'метка: Satu' };
  // метки коллтрекинга-«рефералы» и прочие адреса сайтов: источник неизвестен, сайт известен
  if (/zenith|invest|все звонки|site|сайт|\./.test(s)) return { src: S.SITEUNK, rule: 'метка: переход с сайта / коллтрекинг без сессии' };
  noteUnknown(s, id);
  return { src: S.SITEUNK, rule: 'метка не распознана' };
}

// Источник, выбранный менеджером в Битриксе вручную (когда меток нет)
function sourceByBitrix(name) {
  const n = String(name || '').toLowerCase();
  if (/satu/.test(n)) return S.SATU;
  if (/(google|yandex|bing) seo/.test(n)) return S.SEO;
  if (/google ppc/.test(n)) return S.GOOGLE;
  if (/yandex ppc/.test(n)) return S.YANDEX;
  return null;
}

// ================= НАПРАВЛЕНИЯ =================
// порядок важен: сначала узкие признаки, потом общие (эмаль/грунт/краска — в конце, это ЛКМ)
const DIRS = [
  [/ognez|огнез|огз|kedr|кедр|огнестойк|по дереву/, 'Огнезащита'],
  [/antikor|антикор|ржавч|грунт-эмал|zinc|цинк|оцинк|бэп|мет-аф|анткиор|уретан/, 'Антикор'],
  [/gidroiz|гидро|obmazoch|rulonn|мастик|рулонн|ризолин|kazrez|krbk|rizolin|битум|праймер|жидк\w* резин|кровл|(^|[^а-я])рул|тилит|биполь|техноэласт|унифлекс/, 'Гидроизоляция'],
  [/napoln|nalivn|polimern|poly|topping|наполь|наливн|полимерн|топпинг|упрочн|(^|[^а-я])пол(ы|ов|а)?([^а-я]|$)/, 'Полы'],
  [/rastvor|раствор|ксилол|сольвент|толуол|ацетон|(^|[^0-9])646([^0-9]|$)|уайт|(^|[^а-я])р-?(4|5|647|648|650)([^0-9]|$)/, 'Растворители'],
  [/lkm|lakokras|laki-kraski|лкм|лакокрас|эмал|грунт|краск|kraska|(^|[^а-я])лак|(^|[^а-я])(ак|нц|хп|мл|пф|гф|хв|эп|ур|ко|кч)-?\d|вд-ва|элкон|церта/, 'ЛКМ'],
];
const dirOf = (t) => { const s = String(t || '').toLowerCase(); if (/кмс|kms|ремаркет|remarket/.test(s)) return 'Все направления'; for (const [re, d] of DIRS) if (re.test(s)) return d; return ''; };
const NO_DIR = 'не определено';

// ================= САЙТ =================
const pageOf = (x) => { const m = String(x.sdesc || '').match(/https?:\/\/[^\s,|]+/); return m ? m[0] : ''; };
function siteOfUrl(p) {
  let u; try { u = new URL(p); } catch (e) { return ''; }
  const h = u.hostname.toLowerCase();
  if (/^lp\./.test(h) || /^\/lp\//.test(u.pathname)) return 'lp';
  if (/(^|\.)zenith-invest\.kz$/.test(h)) return 'invest';
  if (/(^|\.)zenith-i\.kz$/.test(h)) return 'site';
  return '';
}
// по названию кампании (для расхода) или тексту метки: invest / lp / site
const siteOfText = (txt) => {
  const s = String(txt || '').toLowerCase();
  if (/инвест|invest/.test(s)) return 'invest';
  if (/лендинг|ленд|land|(^|[^a-z])lp([^a-z]|$)/.test(s)) return 'lp';
  if (/сайт|site|zenith-i/.test(s)) return 'site';
  return '';
};
// каналы WhatsApp (Wazzup) -> сайт виджета YourGood
const WA_SITE = { WZ669bb52f: 'invest', WZ27c77c31: 'invest', WZ08a43356: 'site' };
const waSite = (sourceId) => { const k = String(sourceId || '').slice(0, 10); return WA_SITE[k] || ''; };

// ================= СПОСОБ СВЯЗИ =================
function methodOf(x) {
  const sd = String(x.sdesc || '').toLowerCase();
  const id = String(x.source || ''), n = String(x.sourceName || '').toLowerCase();
  if (/способ: калькулятор/.test(sd)) return 'Калькулятор';
  if (/способ: форма/.test(sd)) return 'Форма';
  if (/quiz|квиз/.test(n) || id === '22') return 'Квиз';
  if (/^WZ|whatsapp|wazzup|wapi|ватсап|вацап|wa_connector/i.test(id + ' ' + n)) return 'WhatsApp';
  if (id === 'CALL' || id === 'CALLBACK' || /звонок|call|телефон/.test(n)) return 'Звонок';
  if (id === 'EMAIL' || /почт|mail/.test(n)) return 'Email';
  if (id === 'WEB' || id === 'WEBFORM' || /сайт|веб/.test(n)) return 'Форма';
  return 'Другое';
}

// подпись канала для лидов без источника: WhatsApp — номер, звонок — линия
const PHONE_LINES = { 'ТОО Zenith invest': '+7 708 540-41-40', '7018004626': '+7 701 800-46-26', 'Входящий звонок 2': 'линия 2' };
const channelOf = (name, desc) => {
  const n = String(name || '').toLowerCase();
  if (!n) return 'Источник в Битриксе не указан';
  if (/wapi|whatsapp|wazzup|ватсап|вацап/.test(n)) {
    const num = (String(name).match(/7\d{10}/) || [])[0];
    return num ? 'WhatsApp ' + num : 'WhatsApp';
  }
  if (/звонок|call|телефон/.test(n)) {
    const m = /номер: (.+?)\.?$/m.exec(String(desc || '').trim());
    const own = (String(name).match(/\+?7\d{10}/) || [])[0];
    if (own) return 'Звонок · ' + own;
    if (!m) return 'Звонок';
    const line = m[1].trim();
    return 'Звонок · ' + (PHONE_LINES[line] || line);
  }
  if (/почт|mail/.test(n)) return 'Email';
  return name;
};

// ================= КАМПАНИИ (Google / Meta) =================
function matchFamily(apiKey, text) {
  const t = String(text || '').toLowerCase();
  for (const rule of maps[apiKey] || []) {
    if (rule.match.some((group) => group.every((w) => t.includes(w.toLowerCase())))) return rule.family;
  }
  return null;
}
const cabinetIndex = { [S.GOOGLE]: { id: {}, name: {}, site: {} }, [S.META]: { id: {}, name: {}, site: {} } };
const unmatchedCabinet = {};
function cabinetFamily(src, id, name) {
  const key = API[src];
  const byRule = matchFamily(key, name);
  const fam = byRule || name || '(кампания ' + id + ')';
  if (!byRule) unmatchedCabinet[src + ' | ' + name] = (unmatchedCabinet[src + ' | ' + name] || 0) + 1;
  const idx = cabinetIndex[src];
  idx.id[String(id)] = fam; idx.name[String(name || '').toLowerCase()] = fam;
  const st = siteOfText(name);
  idx.site[String(id)] = st; idx.site[String(name || '').toLowerCase()] = st;
  return fam;
}
const unmatchedUtm = {};
function utmFamily(src, utmCampaign) {
  if (!HAS_API.has(src)) return NO_CAMPAIGN;
  const raw = String(utmCampaign || '').trim();
  if (!raw) return '(без названия кампании)';
  const idx = cabinetIndex[src];
  const low = raw.toLowerCase();
  if (idx.id[raw]) return idx.id[raw];
  if (idx.name[low]) return idx.name[low];
  const byRule = matchFamily(API[src], raw);
  if (byRule) return byRule;
  const k = src + ' | ' + raw;
  unmatchedUtm[k] = (unmatchedUtm[k] || 0) + 1;
  return /^\d+$/.test(raw) ? '(метка-id, не найден в кабинете)' : '(метка не распознана)';
}

// ================= КОПИЛКА СТРОК =================
// d день, p источник, c кампания/подпись, s сайт, m способ, n направление
const rows = new Map();
function bucket(d, p, c, s = '', m = '', n = '') {
  const k = [d, p, c, s, m, n].join('|');
  let r = rows.get(k);
  if (!r) { r = { d, p, c, s, m, n, sp: 0, spn: 0, usd: 0, cl: 0, im: 0, cv: 0, l: 0, cn: 0, q: 0, pay: 0, rev: 0 }; rows.set(k, r); }
  return r;
}

// ---------- курс и комиссии ----------
const rates = settings.usdToKzt || {};
const rateFor = (d) => Number(rates[month(d)] || rates.default || 500);
// В кабинете расход без комиссии и НДС. sp = с комиссиями, spn = как в кабинете.
const comm = settings.commission || {};
const factor = (src) => { const c = comm[COMM_KEY[src] || src]; return c ? (1 + (c.fee || 0)) * (1 + (c.vat || 0)) : 1; };

// ================= РАСХОД =================
google.rows.forEach((r) => cabinetFamily(S.GOOGLE, r.campaignId, r.campaignName));
meta.rows.forEach((r) => cabinetFamily(S.META, r.campaignId, r.campaignName));
const exclude = (settings.excludeCampaignKeywords || []).map((k) => k.toLowerCase());
const excluded = (name) => exclude.some((k) => String(name || '').toLowerCase().includes(k));
const famDir = (fam, name) => dirOf(fam) || dirOf(name) || NO_DIR;

google.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const fam = cabinetFamily(S.GOOGLE, r.campaignId, r.campaignName);
  const b = bucket(r.date, S.GOOGLE, fam, siteOfText(r.campaignName), '', famDir(fam, r.campaignName));
  const net = r.costUsd * rateFor(r.date);
  b.usd += r.costUsd; b.spn += net; b.sp += net * factor(S.GOOGLE);
  b.cl += r.clicks; b.im += r.impressions; b.cv += r.conversions;
});
let googleStale = false;
if (googleMissing && prevData) {
  googleStale = true;
  prevData.rows.filter((r) => (r.p === 'Google' || r.p === S.GOOGLE) && (r.sp || r.usd)).forEach((r) => {
    const b = bucket(r.d, S.GOOGLE, r.c, r.s !== undefined ? r.s : siteOfText(r.c), '', r.n || famDir(r.c, ''));
    b.sp += r.sp; b.spn += r.spn || 0; b.usd += r.usd || 0; b.cl += r.cl; b.im += r.im; b.cv += r.cv;
  });
}
meta.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const fam = cabinetFamily(S.META, r.campaignId, r.campaignName);
  const b = bucket(r.date, S.META, fam, siteOfText(r.campaignName), '', famDir(fam, r.campaignName));
  const net = r.spendUsd * rateFor(r.date);
  b.usd += r.spendUsd; b.spn += net; b.sp += net * factor(S.META);
  b.cl += r.clicks; b.im += r.impressions; b.cv += r.leads;
});
// Яндекс.Директ из API (в тенге). Если за месяц есть API, ручной ввод за месяц не используется.
const yandexMonths = new Set();
yandex.rows.forEach((r) => {
  if (r.date < FIRST || excluded(r.campaignName)) return;
  const b = bucket(r.date, S.YANDEX, NO_CAMPAIGN, siteOfText(r.campaignName) || 'site', '', dirOf(r.campaignName) || NO_DIR);
  b.spn += r.cost; b.sp += r.cost * factor(S.YANDEX);
  b.cl += r.clicks; b.im += r.impressions;
  yandexMonths.add(month(r.date));
});
// кампании кабинета без признака сайта в названии (для диагностики)
const noSite = {};
[[S.GOOGLE, google.rows, (r) => r.costUsd], [S.META, meta.rows, (r) => r.spendUsd]].forEach(([p, arr, usd]) => arr.forEach((r) => {
  if (r.date < FIRST || siteOfText(r.campaignName)) return;
  const k = p + ' | ' + r.campaignName;
  noSite[k] = (noSite[k] || 0) + usd(r) * rateFor(r.date) * factor(p);
}));
// ручной расход (Satu, Яндекс, SEO, ChatGPT …), равномерно по дням месяца до сегодняшнего дня
// сайт для ручного расхода: SEO — zenith-invest (бюджет SEO на новый сайт), Яндекс — zenith-i, прочее — неизвестно
const MANUAL_SITE = { [S.SEO]: 'invest', [S.YANDEX]: 'site', [S.CHATGPT]: 'invest' };
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
Object.entries(manualAll).forEach(([key, byMonth]) => {
  const src = MANUAL_SRC[key] || key;
  Object.entries(byMonth).forEach(([ym, total]) => {
    if (src === S.YANDEX && yandexMonths.has(ym)) return;
    const [y, m] = ym.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const perDay = total / daysInMonth;
    for (let i = 1; i <= daysInMonth; i++) {
      const d = ym + '-' + String(i).padStart(2, '0');
      if (d < FIRST || d > today) continue;
      const mb = bucket(d, src, NO_CAMPAIGN, MANUAL_SITE[src] || '', '', 'Все направления');
      mb.spn += perDay; mb.sp += perDay * factor(src);
    }
  });
});

// ================= ЛИДЫ =================
const okId = (v) => (v && String(v) !== '0' ? String(v) : null);
const ctCard = new Map(bxContacts.rows.map((c) => [String(c.id), c]));
const own = (e) => { const r = sourceOf(e.utm, e.id); return r && REAL.has(r.src) ? r.src : null; };
const leads = bxLeads.rows.map((x) => ({ ...x, day: day(x.created), own: sourceOf(x.utm, x.id) }));

// клиент: история по контакту, телефону и компании
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
  const it = { id, created: e.created, own: own(e), utm: e.utm, kind, ref: e, paid: kind === 'продажа' && up(e.stage) === PAID };
  keysOf(e).forEach((k) => { if (!clientIdx.has(k)) clientIdx.set(k, []); clientIdx.get(k).push(it); });
});
const itemsOf = (e) => {
  const m = new Map();
  keysOf(e).forEach((k) => (clientIdx.get(k) || []).forEach((it) => m.set(it.id, it)));
  return [...m.values()].filter((it) => it.id !== String(e.id));
};
const isRepeat = (e) => {
  if (/повтор/i.test(e.type || '')) return true;
  if (/существующ|повторн/i.test(e.sourceName || '')) return true;
  const c = ctCard.get(okId(e.contact) || '');
  if (c && /существующ|повторн/i.test(c.sourceName || '')) return true;
  const eDay = day(e.created);
  return itemsOf(e).some((it) => it.paid && day(it.ref.closed || it.ref.modified) < eDay);
};

// Источник лида по правилам (первое совпадение) -> { src, utm, rule }
function attribute(x) {
  const ov = (settings.leadOverrides || {})[String(x.id)];
  if (ov && ov.platform) return { src: MANUAL_SRC[ov.platform] || (ov.platform === 'Google' ? S.GOOGLE : ov.platform === 'Meta' ? S.META : ov.platform), utm: x.utm, rule: 'ручная правка сделки' };
  if (x.own && x.own.src !== S.SITEUNK) return { src: x.own.src, utm: x.utm, rule: x.own.rule };
  const prior = itemsOf(x).filter((it) => it.own && it.created <= x.created).sort((p, q) => (p.created < q.created ? 1 : -1))[0];
  if (prior) return { src: prior.own, utm: prior.utm, rule: 'история клиента: ранее была метка' };
  const c = ctCard.get(okId(x.contact) || '');
  const cs = c && sourceOf(c.utm, x.id);
  if (cs && REAL.has(cs.src)) return { src: cs.src, utm: c.utm, rule: 'метки в карточке контакта' };
  const bx = sourceByBitrix(x.sourceName);
  if (bx) return { src: bx, utm: null, rule: 'источник выбран в Битриксе' };
  if (isRepeat(x)) return { src: S.REPEAT, utm: null, rule: 'клиент уже покупал' };
  if (x.own) return { src: S.SITEUNK, utm: x.utm, rule: x.own.rule };
  return { src: S.NONE, utm: null, rule: 'меток нет нигде' };
}

// Сайт лида — только по фактам
function siteOfLead(x, a) {
  const p = pageOf(x);
  const ps = p ? siteOfUrl(p) : '';
  if (ps) return { s: ps, how: 'страница заявки' };
  const ws = waSite(x.source);
  if (ws) {
    const u = x.utm || {};
    if (ws === 'site' && /(^|_)lp($|_)|landing/.test(String(u.campaign || '') + ' ' + String(u.source || ''))) return { s: 'lp', how: 'WhatsApp YourGood zenith-i, метка лендинга' };
    return { s: ws, how: 'номер WhatsApp (виджет YourGood)' };
  }
  const u = x.utm || {};
  const us = String(u.source || '').toLowerCase();
  if (x.source === 'CALL' && us) {
    if (/satu/.test(us)) return { s: '', how: 'коллтрекинг: номер Satu' };
    if (/landing_/.test(us)) return { s: 'lp', how: 'коллтрекинг: номер лендинга' };
    return { s: 'invest', how: 'коллтрекинг: подменный номер zenith-invest' };
  }
  if (us === 'landing' || us === 'lp') return { s: 'lp', how: 'метка лендинга' };
  const bySrcText = siteOfText([u.campaign, u.content].join(' '));
  if (bySrcText) return { s: bySrcText, how: 'название кампании в метке' };
  if (a.utm && a.utm !== x.utm) { const t = siteOfText([a.utm.campaign, a.utm.content].join(' ')); if (t) return { s: t, how: 'метка из истории клиента' }; }
  return { s: '', how: 'неизвестно' };
}

const ruleStats = {};       // правило источника -> число лидов (с 1 ноября)
const siteStats = {};       // правило сайта -> число лидов (с 1 ноября)
const noDirIds = [];
const stagesLeads = {};
const utmSources = {};
const utmShare = {};
const qualList = [];
let leadsCounted = 0, leadsWithUtm = 0, cleanTotal = 0, qualTotal = 0;
const STAT_FROM = settings.statsFrom || '2026-11-01';

leads.forEach((x) => {
  stagesLeads[x.stage] = (stagesLeads[x.stage] || 0) + 1;
  if (x.day < FIRST) return;
  const st = up(x.stage);
  const clean = !NOT_CLEAN.includes(st);
  const qual = st === QUAL;
  const ov = (settings.leadOverrides || {})[String(x.id)] || {};
  const a = attribute(x);
  x.eff = a.src;
  const fam = HAS_API.has(a.src) ? (ov.family || utmFamily(a.src, (a.utm || {}).campaign)) : '';
  const site = ov.site !== undefined ? { s: ov.site, how: 'ручная правка сделки' } : siteOfLead(x, a);
  const m = methodOf(x);
  const page = pageOf(x);
  let path = ''; try { path = page ? new URL(page).pathname : ''; } catch (e) { path = ''; }
  const n = dirOf(fam) || dirOf((a.utm || {}).campaign) || dirOf(path) || dirOf(x.title) || NO_DIR;
  let c;
  if (HAS_API.has(a.src)) c = fam;
  else if (a.src === S.NONE || a.src === S.REPEAT || a.src === S.SITEUNK) c = channelOf(x.sourceName || x.source, x.sdesc);
  else c = n;
  x.family = c; x.site = site.s; x.m = m; x.n = n;
  const b = bucket(x.day, a.src, c, site.s, m, n);
  b.l += 1;
  if (clean) b.cn += 1;
  if (qual) { b.q += 1; qualList.push({ id: x.id, d: x.day, s: site.s, p: a.src, c, m, n }); }
  if (x.day >= STAT_FROM && clean) {
    ruleStats[a.rule] = (ruleStats[a.rule] || 0) + 1;
    siteStats[site.how] = (siteStats[site.how] || 0) + 1;
    if (n === NO_DIR && noDirIds.length < 40) noDirIds.push(String(x.id));
  }
  leadsCounted++; if (x.own) leadsWithUtm++;
  if (clean) cleanTotal++; if (qual) qualTotal++;
  const mo = month(x.day);
  utmShare[mo] = utmShare[mo] || { leads: 0, withUtm: 0 };
  utmShare[mo].leads++; if (x.own) utmShare[mo].withUtm++;
  const sk = (x.utm.source || '(пусто)').toLowerCase();
  utmSources[sk] = utmSources[sk] || { n: 0, platform: x.own ? x.own.src : '—' };
  utmSources[sk].n++;
});

// ================= ОПЛАТЫ =================
const byContact = new Map();
leads.forEach((x) => {
  if (!x.contact || !x.eff || !REAL.has(x.eff)) return;
  if (!byContact.has(x.contact)) byContact.set(x.contact, []);
  byContact.get(x.contact).push(x);
});
byContact.forEach((arr) => arr.sort((p, q) => (p.created < q.created ? -1 : 1)));
const plusOneDay = (iso) => { const d = new Date(day(iso) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const stagesSales = {};
const payList = [];
const unknownPays = [];
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
  let platform = null, camp = NO_CAMPAIGN, site = '', m = '', n = '';
  const cands = s.contact ? byContact.get(s.contact) : null;
  if (!s.contact) pay.noContact++;
  if (cands && cands.length) {
    const limit = plusOneDay(s.created);
    const first = cands.find((x) => x.day <= limit) || null;
    if (first) { platform = first.eff; camp = first.family; site = first.site || ''; m = first.m; n = first.n; pay.viaContact++; }
  }
  if (!platform) {
    const o = own(s);
    if (o) { platform = o; camp = HAS_API.has(o) ? utmFamily(o, s.utm.campaign) : dirOf(s.utm.campaign) || NO_DIR; site = siteOfText([s.utm.campaign, s.utm.content].join(' ')); pay.viaOwnUtm++; }
  }
  if (!platform) {
    const pool = itemsOf(s).filter((it) => it.own && day(it.created) <= payDay).sort((a, b) => (a.created < b.created ? -1 : 1));
    if (pool.length) {
      const h = pool[0];
      platform = h.own; camp = h.ref.family || (HAS_API.has(h.own) ? utmFamily(h.own, h.utm.campaign) : NO_DIR);
      site = h.ref.site !== undefined ? h.ref.site : ''; m = h.ref.m || ''; n = h.ref.n || ''; pay.viaHistory++;
    }
  }
  if (!platform) {
    const c = ctCard.get(okId(s.contact) || '');
    const cs = c && sourceOf(c.utm, s.id);
    if (cs && REAL.has(cs.src)) { platform = cs.src; camp = HAS_API.has(cs.src) ? utmFamily(cs.src, c.utm.campaign) : NO_DIR; pay.viaContactUtm++; }
  }
  if (!platform && /satu/i.test(String(s.sourceName || ''))) platform = S.SATU;
  if (!platform) {
    const c = ctCard.get(okId(s.contact) || '');
    const ls = allByContact.get(s.contact) || [];
    const srcName = s.sourceName || (ls.find((x) => x.sourceName) || {}).sourceName || (c && c.sourceName) || histSrc.get(String(s.contact)) || '';
    platform = isRepeat(s) ? S.REPEAT : S.NONE; camp = channelOf(srcName); pay.unknown++;
    if (payDay >= '2026-10-15') unknownPays.push({ id: s.id, created: s.created, paid: payDay, amount: Math.round(s.amount), platform, contact: s.contact, utm: s.utm });
  }
  const b = bucket(payDay, platform, camp, site, m, n || NO_DIR);
  b.pay += 1; b.rev += s.amount;
  payList.push({ id: s.id, d: payDay, s: b.s, p: platform, c: camp, m: b.m, n: b.n, a: Math.round(s.amount) });
});

// ================= ИТОГ =================
const round = (v) => Math.round(v * 100) / 100;
const outRows = [...rows.values()]
  .map((r) => ({ ...r, sp: round(r.sp), spn: round(r.spn), usd: round(r.usd), cv: round(r.cv), rev: round(r.rev) }))
  .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.p < b.p ? -1 : 1));
const top = (obj, k) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, v]) => ({ k: key, n: v }));

const output = {
  generatedAt: new Date().toISOString(),
  firstDate: FIRST,
  statsFrom: STAT_FROM,
  schema: 2,
  rates,
  commission: comm,
  portal: settings.bitrixPortal || 'macron.bitrix24.kz',
  rows: outRows,
  pays: payList.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : Number(b.id) - Number(a.id))),
  quals: qualList.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : Number(b.id) - Number(a.id))),
  diagnostics: {
    googleStale,
    rules: top(ruleStats, 30),
    siteRules: top(siteStats, 20),
    unknownSources: Object.entries(unknownSources).sort((a, b) => b[1].n - a[1].n).slice(0, 30).map(([k, v]) => ({ k, n: v.n, ids: v.ids })),
    noDirIds,
    unknownPays,
    noSiteCampaigns: Object.entries(noSite).map(([k, v]) => ({ k, sp: Math.round(v) })).sort((a, b) => b.sp - a.sp).slice(0, 40),
    leads: { total: leadsCounted, withUtm: leadsWithUtm, clean: cleanTotal, qualified: qualTotal },
    utmShareByMonth: utmShare,
    payments: pay,
    stagesLeads,
    stagesSales,
    utmSources,
    unmatchedUtm: top(unmatchedUtm, 30),
    unmatchedCabinet: top(unmatchedCabinet, 30),
    fetchedAt: { google: google.fetchedAt || null, meta: meta.fetchedAt || null, yandex: yandex.fetchedAt || null, bitrix: bxLeads.fetchedAt || null },
  },
};

fs.writeFileSync(path.join(root, 'data', 'data.json'), JSON.stringify(output));
console.log('data.json: ' + outRows.length + ' строк | лидов ' + leadsCounted + ' (с меткой ' + leadsWithUtm + '), квалов ' + qualTotal + ', оплат ' + pay.total +
  ' (через контакт ' + pay.viaContact + ', по своей метке ' + pay.viaOwnUtm + ', не определено ' + pay.unknown + ')');
