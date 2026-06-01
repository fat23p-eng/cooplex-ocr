// api/quota.js — ดึง/ใช้ quota จาก Vercel KV (เชื่อถือได้ ล้างไม่ได้)
// ต้องตั้ง env: KV_REST_API_URL, KV_REST_API_TOKEN

// quota ฟรีต่อวัน (reset เที่ยงคืน)
const FREE_DAILY = { ask: 5, inspect: 0, ocr: 0 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, action } = req.body; // action: 'get' | 'use'
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const today = new Date().toISOString().slice(0, 10); // "2025-05-31"

    // ── ดึง quota bonus (ที่ซื้อ) ─────────────────────────
    const bonusKey   = `quota:${userId}`;
    const bonusRaw   = await kvFetch('GET', bonusKey);
    const bonus      = bonusRaw ? JSON.parse(bonusRaw) : { ask: 0, inspect: 0, ocr: 0 };

    // ── ดึง quota ฟรีที่ใช้วันนี้ ─────────────────────────
    const dailyKey   = `daily:${userId}:${today}`;
    const dailyRaw   = await kvFetch('GET', dailyKey);
    const dailyUsed  = dailyRaw ? JSON.parse(dailyRaw) : { ask: 0, inspect: 0, ocr: 0 };

    // ── คำนวณ quota คงเหลือ ───────────────────────────────
    const quota = {
      ask:     Math.max(0, FREE_DAILY.ask     - dailyUsed.ask)     + (bonus.ask     || 0),
      inspect: Math.max(0, FREE_DAILY.inspect - dailyUsed.inspect) + (bonus.inspect || 0),
      ocr:     Math.max(0, FREE_DAILY.ocr     - dailyUsed.ocr)     + (bonus.ocr     || 0),
    };

    if (action === 'get') {
      return res.status(200).json({ ok: true, quota, dailyUsed, bonus });
    }

    if (action === 'use') {
      const { type } = req.body; // 'ask' | 'inspect' | 'ocr'
      if (!type) return res.status(400).json({ error: 'Missing type' });

      if (quota[type] <= 0) {
        return res.status(200).json({ ok: false, reason: 'quota_empty', quota });
      }

      // หักจาก free daily ก่อน ถ้าหมดค่อยหัก bonus
      const freeLeft = Math.max(0, FREE_DAILY[type] - dailyUsed[type]);
      if (freeLeft > 0) {
        // หัก daily
        const newDaily = { ...dailyUsed, [type]: dailyUsed[type] + 1 };
        // daily key หมดอายุตอนเที่ยงคืน (86400 วินาที)
        const secsToMidnight = 86400 - (Math.floor(Date.now() / 1000) % 86400);
        await kvFetch('SET', dailyKey, JSON.stringify(newDaily), 'EX', secsToMidnight);
      } else {
        // หัก bonus
        const newBonus = { ...bonus, [type]: Math.max(0, (bonus[type] || 0) - 1) };
        await kvFetch('SET', bonusKey, JSON.stringify(newBonus), 'EX', 60 * 60 * 24 * 365);
      }

      const newQuota = { ...quota, [type]: quota[type] - 1 };
      console.log('Quota used:', userId, type, '→ left:', newQuota[type]);
      return res.status(200).json({ ok: true, quota: newQuota });
    }

    return res.status(400).json({ error: 'action must be get or use' });

  } catch (err) {
    console.error('quota error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Vercel KV REST helper ────────────────────────────
async function kvFetch(cmd, ...args) {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env vars not set (KV_REST_API_URL, KV_REST_API_TOKEN)');

  const r = await fetch(`${url}/${[cmd, ...args].map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d = await r.json();
  return d.result ?? null;
}
