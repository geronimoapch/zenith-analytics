// Разовая диагностика: какие картинки Meta ставит в какие плейсменты (asset customization).
const API = 'https://graph.facebook.com/v21.0';
const T = process.env.META_ACCESS_TOKEN; let A = process.env.META_AD_ACCOUNT_ID || '';
if (!A.startsWith('act_')) A = 'act_' + A;
const get = async (p, q) => { const u = new URL(API + p); u.searchParams.set('access_token', T); for (const [k, v] of Object.entries(q || {})) u.searchParams.set(k, v); const r = await fetch(u); return r.json(); };
(async () => {
  const ads = await get(`/${A}/ads`, { fields: 'id,name,adset{name},effective_status,creative{id}', limit: '100', effective_status: '["ACTIVE"]' });
  if (ads.error) { console.log('ERR', JSON.stringify(ads.error)); return; }
  for (const ad of ads.data || []) {
    const c = await get('/' + ad.creative.id, { fields: 'object_type,image_hash,asset_feed_spec,degrees_of_freedom_spec,object_story_spec{link_data{image_hash,picture},video_data{image_hash}}' });
    const f = c.asset_feed_spec || {};
    const imgs = (f.images || []).map((i) => (i.adlabels || []).map((l) => l.name).join('/') + ':' + String(i.hash).slice(0, 6));
    const vids = (f.videos || []).map((i) => (i.adlabels || []).map((l) => l.name).join('/') + ':' + i.video_id);
    const rules = (f.asset_customization_rules || []).map((r) => {
      const s = r.customization_spec || {};
      const pl = [...(s.publisher_platforms || []), ...(s.facebook_positions || []).map((x) => 'fb:' + x), ...(s.instagram_positions || []).map((x) => 'ig:' + x), ...(s.messenger_positions || []).map((x) => 'ms:' + x), ...(s.threads_positions || []).map((x) => 'th:' + x)].join(',');
      const lab = [r.image_label, r.video_label].filter(Boolean).map((l) => l.name).join('');
      return `[${r.priority}] ${lab} -> ${pl}`;
    });
    const fmt = (f.ad_formats || []).join(',');
    const dof = JSON.stringify(((c.degrees_of_freedom_spec || {}).creative_features_spec) || {}).replace(/"enroll_status":/g, '');
    console.log(`\n== ${ad.adset && ad.adset.name} | ${ad.name} | ${c.object_type} | formats=${fmt}\n imgs=${imgs.join(' ')} vids=${vids.join(' ')}\n rules=${rules.join(' ; ') || 'НЕТ'}\n dof=${dof.slice(0, 400)}`);
  }
})();
