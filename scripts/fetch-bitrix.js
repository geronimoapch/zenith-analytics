// Выгружает из Битрикс24 все сделки двух воронок (лиды и продажи) через
// входящий вебхук. Результат: data/raw/bitrix-leads.json и bitrix-sales.json
// Персональные данные (телефоны, имена) сюда не попадают, только id контакта.
//
// Секрет: BITRIX_WEBHOOK_URL вида https://xxx.bitrix24.kz/rest/1/abcdef123456/

const { readJson, writeRaw, need, sleep } = require('./lib');

let BASE;
let lastCall = 0;

async function call(method, params = {}) {
  // Битрикс разрешает ~2 запроса в секунду
  const wait = 550 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(BASE + method + '.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const text = await r.text();
    let d;
    try { d = JSON.parse(text); } catch { throw new Error(`Bitrix ${method}: не JSON (HTTP ${r.status}): ${text.slice(0, 300)}`); }
    if (d.error === 'QUERY_LIMIT_EXCEEDED' && attempt < 4) { await sleep(2000 * attempt); continue; }
    if (d.error) throw new Error(`Bitrix ${method}: ${d.error} — ${d.error_description || ''}`);
    return d;
  }
}

// Список воронок: пробуем новый метод, потом старый
async function getCategories() {
  const out = [{ id: 0, name: 'Общая' }];
  try {
    const d = await call('crm.category.list', { entityTypeId: 2 });
    const list = (d.result && d.result.categories) || d.result || [];
    list.forEach((c) => { if (Number(c.id) !== 0) out.push({ id: Number(c.id), name: c.name }); });
    return out;
  } catch (e1) {
    try {
      const d = await call('crm.dealcategory.list', {});
      (d.result || []).forEach((c) => out.push({ id: Number(c.ID), name: c.NAME }));
      return out;
    } catch (e2) {
      throw new Error('Не получилось получить список воронок. ' + e1.message + ' | ' + e2.message +
        '. Проверь, что у вебхука есть право CRM и что в секрете адрес вида https://домен/rest/1/код/');
    }
  }
}

async function getStages() {
  // STATUS_ID -> название этапа (для всех воронок: DEAL_STAGE и DEAL_STAGE_<id>)
  const map = {};
  const d = await call('crm.status.list', {});
  (d.result || []).forEach((s) => {
    if (String(s.ENTITY_ID || '').startsWith('DEAL_STAGE')) map[s.STATUS_ID] = s.NAME;
  });
  return map;
}

// Справочник «Источник»: id -> название (например, название веб-формы)
async function getSources() {
  const map = {};
  try {
    const d = await call('crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } });
    (d.result || []).forEach((s) => { map[s.STATUS_ID] = s.NAME; });
  } catch (e) { console.log('Битрикс: справочник источников не получен: ' + e.message); }
  return map;
}

async function listDeals(categoryId, from) {
  const select = [
    'ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'DATE_CREATE', 'DATE_MODIFY', 'CLOSEDATE', 'OPPORTUNITY',
    'CONTACT_ID', 'SOURCE_ID', 'SOURCE_DESCRIPTION',
    'UTM_SOURCE', 'UTM_MEDIUM', 'UTM_CAMPAIGN', 'UTM_CONTENT', 'UTM_TERM', 'UF_*',
  ];
  const out = [];
  let start = 0;
  while (true) {
    const d = await call('crm.deal.list', {
      filter: { CATEGORY_ID: categoryId, '>=DATE_CREATE': from + 'T00:00:00' },
      select,
      order: { ID: 'ASC' },
      start,
    });
    (d.result || []).forEach((x) => out.push(x));
    if (d.next === undefined || d.next === null) break;
    start = d.next;
  }
  return out;
}

async function main() {
  need(['BITRIX_WEBHOOK_URL']);
  // Берём только https://домен/rest/<id>/<код>/ — даже если в секрет вставили адрес с названием метода на конце
  const m = process.env.BITRIX_WEBHOOK_URL.trim().match(/^(https?:\/\/[^\/]+\/rest\/\d+\/[^\/]+\/)/);
  if (!m) throw new Error('Адрес вебхука в BITRIX_WEBHOOK_URL должен выглядеть как https://домен/rest/1/код/');
  BASE = m[1];
  console.log('Битрикс: домен ' + BASE.split('/')[2]);

  const settings = readJson('config/settings.json', {});
  // Берём историю на полгода раньше: нужно, чтобы находить первый лид у клиента, который купил позже
  const first = new Date(settings.firstDate || '2026-06-01');
  first.setUTCMonth(first.getUTCMonth() - 6);
  const from = first.toISOString().slice(0, 10);

  const cats = await getCategories();
  const stages = await getStages();
  const sources = await getSources();
  // В settings.json воронку можно указать названием или числом (id воронки)
  const pick = (v) => cats.find((c) => (typeof v === 'number' ? c.id === v : c.name.trim().toLowerCase() === String(v).trim().toLowerCase()));
  const leadCat = pick(settings.funnels.leads);
  const saleCat = pick(settings.funnels.sales);
  if (!leadCat || !saleCat) {
    const stagesOf = (id) => Object.entries(stages)
      .filter(([k]) => (id === 0 ? !k.includes(':') : k.startsWith('C' + id + ':')))
      .map(([, v]) => v).join(' / ');
    throw new Error('Не нашёл воронки в Битрикс. Есть такие:\n' +
      cats.map((c) => `«${c.name}» (id ${c.id}): ${stagesOf(c.id)}`).join('\n') +
      '\nВпиши точные названия в config/settings.json → funnels.');
  }

  const leads = await listDeals(leadCat.id, from);
  const sales = await listDeals(saleCat.id, from);
  const stageName = (id) => stages[id] || id;
  // пользовательские поля сделки (UF_*): берём только непустые, обрезаем до 300 символов
  const ufOf = (x) => {
    const o = {};
    Object.keys(x).forEach((k) => {
      if (!k.startsWith('UF_')) return;
      let val = x[k];
      if (Array.isArray(val)) val = val.join(' ');
      if (val === null || val === undefined || val === '' || val === false) return;
      o[k] = String(val).slice(0, 300);
    });
    return o;
  };
  const shape = (x) => ({
    id: x.ID,
    created: x.DATE_CREATE,
    modified: x.DATE_MODIFY,
    closed: x.CLOSEDATE,
    stage: stageName(x.STAGE_ID),
    amount: Number(x.OPPORTUNITY || 0),
    contact: x.CONTACT_ID || null,
    source: x.SOURCE_ID || '',
    sourceName: sources[x.SOURCE_ID] || '',
    title: x.TITLE || '',
    srcDesc: x.SOURCE_DESCRIPTION || '',
    uf: ufOf(x),
    utm: { source: x.UTM_SOURCE || '', medium: x.UTM_MEDIUM || '', campaign: x.UTM_CAMPAIGN || '', content: x.UTM_CONTENT || '', term: x.UTM_TERM || '' },
  });

  writeRaw('bitrix-leads.json', { fetchedAt: new Date().toISOString(), funnel: leadCat.name, rows: leads.map(shape) });
  writeRaw('bitrix-sales.json', { fetchedAt: new Date().toISOString(), funnel: saleCat.name, rows: sales.map(shape) });
  // Диагностика: какие поля есть у сделок (без персональных данных: только названия полей, счётчики и адреса страниц без параметров)
  const cnt = (o, k) => { o[k] = (o[k] || 0) + 1; };
  const ufFilled = {}, ufUrl = {}, srcIds = {}, titles = {};
  leads.forEach((x) => {
    cnt(srcIds, x.SOURCE_ID || '(пусто)');
    cnt(titles, String(x.TITLE || '').replace(/\d+/g, '#').slice(0, 40));
    const uf = ufOf(x);
    Object.entries(uf).forEach(([k, val]) => {
      cnt(ufFilled, k);
      if (/^https?:\/\//i.test(val)) { try { const u = new URL(val); const key = k + ' -> ' + u.host + u.pathname.slice(0, 40); cnt(ufUrl, key); } catch (e) { /* не ссылка */ } }
    });
  });
  const top = (o, n, min) => Object.entries(o).filter(([, c]) => c >= (min || 1)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => k + ': ' + c).join(' | ');
  console.log('Битрикс, заполненные UF-поля: ' + top(ufFilled, 25));
  console.log('Битрикс, ссылки в UF-полях: ' + top(ufUrl, 25));
  console.log('Битрикс, SOURCE_ID: ' + top(srcIds, 15));
  console.log('Битрикс, названия источников: ' + Object.entries(srcIds).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k]) => k + ' = ' + (sources[k] || '?')).join(' | '));
  console.log('Битрикс, повторяющиеся названия сделок: ' + top(titles, 15, 5));
  console.log(`Битрикс: лидов ${leads.length} («${leadCat.name}»), продаж ${sales.length} («${saleCat.name}»), с ${from}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
