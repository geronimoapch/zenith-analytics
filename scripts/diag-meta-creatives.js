const API = 'https://graph.facebook.com/v21.0';
const T = process.env.META_ACCESS_TOKEN; let A = process.env.META_AD_ACCOUNT_ID || '';
if (!A.startsWith('act_')) A = 'act_' + A;
const get = async (p, q) => { const u = new URL(API + p); u.searchParams.set('access_token', T); for (const [k, v] of Object.entries(q || {})) u.searchParams.set(k, v); return (await fetch(u)).json(); };
(async () => {
  console.log('PERMS', JSON.stringify(((await get('/me/permissions')).data || []).filter((p) => p.status === 'granted').map((p) => p.permission)));
  const ads = await get(`/${A}/ads`, { fields: 'id,name,adset_id,adset{name},effective_status,creative{id}', limit: '100', effective_status: '["ACTIVE"]' });
  for (const ad of (ads.data || []).filter((a) => /Клод/.test(a.adset.name))) {
    const c = await get('/' + ad.creative.id, { fields: 'name,object_story_spec,url_tags,image_hash,image_url,instagram_user_id,actor_id,call_to_action_type,degrees_of_freedom_spec' });
    console.log('\nAD', JSON.stringify({ ad: ad.id, name: ad.name, adset: ad.adset_id, adsetName: ad.adset.name, creative: c }));
  }
})();
