// api/quota.mjs — เก็บโควต้ารายวันต่อ userId ด้วย Vercel Blob
// ✅ Node.js runtime (เหมือน ask.mjs, inspect.mjs) — ไม่ใช่ Edge runtime

const LIMITS = {
  admin:   { ask: 99999 },
  officer: { ask: 20 },
  guest:   { ask: 5 },
};

function todayKey() {
  // ใช้เวลาไทย (UTC+7) ในการตัดวัน
  const now = new Date();
  const bkk = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 10); // YYYY-MM-DD
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { userId, action, type = 'ask', role = 'guest' } = req.body || {};
    if (!userId) return res.status(400).json({ ok: false, error: 'userId is required' });

    const { list, put } = await import('@vercel/blob');
    const token = process.env.knowledge_public_READ_WRITE_TOKEN
               || process.env.BLOB_READ_WRITE_TOKEN;

    if (!token) {
      console.warn('Blob token not set for quota — fallback to unlimited (fail-open)');
      return res.status(200).json({ ok: true, quota: { ask: 999, used: 0 } });
    }

    const day      = todayKey();
    const fileName = `quota/${userId}_${day}.json`;
    const limit    = (LIMITS[role] || LIMITS.guest)[type] ?? LIMITS.guest.ask;

    // ── อ่านค่าปัจจุบัน ──────────────────────────────────────
    let used = 0;
    try {
      const { blobs } = await list({ token, prefix: fileName });
      const match = blobs.find(b => b.pathname === fileName);
      if (match) {
        const r = await fetch(match.url);
        if (r.ok) {
          const data = await r.json();
          used = data[type] || 0;
        }
      }
    } catch (e) {
      console.warn('quota read error:', e.message);
    }

    // ── action: get ──────────────────────────────────────────
    if (action === 'get') {
      return res.status(200).json({
        ok: true,
        quota: { ask: Math.max(0, limit - used), used, limit },
      });
    }

    // ── action: use ───────────────────────────────────────────
    if (action === 'use') {
      if (used >= limit) {
        return res.status(200).json({
          ok: false,
          quota: { ask: 0, used, limit },
          error: 'หมดโควต้าวันนี้แล้ว',
        });
      }

      const newUsed = used + 1;
      try {
        await put(fileName, JSON.stringify({ [type]: newUsed, updatedAt: Date.now() }), {
          access: 'public',
          token,
          addRandomSuffix: false,
          allowOverwrite: true,
        });
      } catch (e) {
        console.warn('quota write error:', e.message);
      }

      return res.status(200).json({
        ok: true,
        quota: { ask: Math.max(0, limit - newUsed), used: newUsed, limit },
      });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('quota handler error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
