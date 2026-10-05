// Забирает из Яндекс.Директа расход, клики и показы по дням и по кампаниям.
// Результат: data/raw/yandex-direct.json
//
// Секреты: YANDEX_DIRECT_TOKEN (OAuth-токен, право direct:api),
//          YANDEX_DIRECT_LOGIN (логин рекламного аккаунта; нужен, если токен выдан другому логину,
//          например представителю аккаунта или агентству)
//
// Любая ошибка здесь не останавливает остальные источники: причина пишется в лог.

const { readJson, writeRaw, sleep } = require('./lib');

const URL_REPORTS = 'https://api.direct.yandex.com/json/v5/reports';

const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

async function main() {
  const token = process.env.YANDEX_DIRECT_TOKEN;
  if (!token) {
    console.log('ПРОПУСК: не задан секрет YANDEX_DIRECT_TOKEN. Яндекс пока на ручном вводе расхода.');
    return;
  }
  const login = process.env.YANDEX_DIRECT_LOGIN;
  const settings = readJson('config/settings.json', {});
  const from = settings.firstDate || '2026-06-01';
  const to = new Date().toISOString().slice(0, 10);

  const body = {
    params: {
      SelectionCriteria: { DateFrom: from, DateTo: to },
      FieldNames: ['Date', 'CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Cost'],
      ReportName: 'zenith-' + Date.now(),
      ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'NO',
      IncludeDiscount: 'NO',
    },
  };
  const headers = {
    Authorization: 'Bearer ' + token,
    'Accept-Language': 'ru',
    'Content-Type': 'application/json; charset=utf-8',
    processingMode: 'auto',
    returnMoneyInMicros: 'false',
    skipReportHeader: 'true',
    skipReportSummary: 'true',
  };
  if (login) headers['Client-Login'] = login;

  let text = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const r = await fetch(URL_REPORTS, { method: 'POST', headers, body: JSON.stringify(body) });
    const t = await r.text();
    if (r.status === 200) { text = t; break; }
    if (r.status === 201 || r.status === 202) {
      const wait = Math.min(Number(r.headers.get('retryIn')) || 10, 60);
      console.log('Яндекс.Директ: отчёт готовится, ждём ' + wait + ' с (попытка ' + attempt + ')');
      await sleep(wait * 1000);
      continue;
    }
    let hint = '';
    const code = (t.match(/"error_code":\s*(\d+)/) || [])[1];
    if (code === '53') hint = ' Токен недействителен или просрочен: получи новый.';
    if (code === '54') hint = ' У этого логина нет доступа к рекламному аккаунту: добавь его представителем в Директе или укажи YANDEX_DIRECT_LOGIN.';
    if (code === '58') hint = ' Нет доступа к API: прими соглашение и подай заявку в Директе (Настройки → API).';
    console.log('ЯНДЕКС.ДИРЕКТ: ошибка HTTP ' + r.status + ': ' + t.slice(0, 600) + hint);
    return;
  }
  if (text === null) { console.log('ЯНДЕКС.ДИРЕКТ: отчёт так и не подготовился, попробуем в следующий раз.'); return; }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const head = (lines.shift() || '').split('\t');
  const idx = (n) => head.indexOf(n);
  const cols = { d: idx('Date'), id: idx('CampaignId'), name: idx('CampaignName'), im: idx('Impressions'), cl: idx('Clicks'), cost: idx('Cost') };
  if (Object.values(cols).some((i) => i < 0)) {
    console.log('ЯНДЕКС.ДИРЕКТ: неожиданные колонки отчёта: ' + head.join(', '));
    return;
  }
  const rows = lines.map((l) => {
    const p = l.split('\t');
    return {
      date: p[cols.d],
      campaignId: p[cols.id],
      campaignName: p[cols.name],
      impressions: num(p[cols.im]),
      clicks: num(p[cols.cl]),
      cost: num(p[cols.cost]),
    };
  }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));

  writeRaw('yandex-direct.json', { fetchedAt: new Date().toISOString(), rows });
  const campaigns = new Set(rows.map((r) => r.campaignId)).size;
  const total = rows.reduce((s, r) => s + r.cost, 0);
  console.log('Яндекс.Директ: ' + rows.length + ' строк, ' + campaigns + ' кампаний, ' + from + '..' + to + ', расход ' + Math.round(total) + ' (в валюте аккаунта, без НДС)');
}

main().catch((e) => { console.log('ЯНДЕКС.ДИРЕКТ: сбой: ' + e.message); });
