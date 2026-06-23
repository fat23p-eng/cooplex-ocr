// ════════════════════════════════════════════════════════════
// /api/quota.mjs — เก็บโควต้ารายวันต่อ userId ด้วย Vercel Blob
// รองรับ action: 'get' (ดูโควต้าที่เหลือ) / 'use' (ใช้โควต้า 1 ครั้ง)
// ════════════════════════════════════════════════════════════

export const config = { runtime: 'edge' };

// โควต้าต่อวันตาม role (ต้องตรงกับ ROLES ใน index_vercel.html)
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

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return jsonRes({ ok: false, error: 'Method not allowed' }, 405);
  }

  try {
    const body = await req.json();
    const { userId, action, type = 'ask', role = 'guest' } = body;

    if (!userId) return jsonRes({ ok: false, error: 'userId is required' });

    const { list, put } = await import('@vercel/blob');
    const token = process.env.knowledge_public_READ_WRITE_TOKEN
               || process.env.BLOB_READ_WRITE_TOKEN;

    if (!token) {
      console.warn('Blob token not set for quota — fallback to unlimited');
      // ไม่มี token → ปล่อยผ่านแทนบล็อกผู้ใช้ (fail-open)
      return jsonRes({ ok: true, quota: { ask: 999, used: 0 } });
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

    // ── action: get — แค่ดูค่า ไม่เพิ่ม ──────────────────────
    if (action === 'get') {
      return jsonRes({
        ok: true,
        quota: { ask: Math.max(0, limit - used), used, limit },
      });
    }

    // ── action: use — เพิ่มการใช้งาน 1 ครั้ง ─────────────────
    if (action === 'use') {
      if (used >= limit) {
        return jsonRes({
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
        // เขียนไม่ได้ก็ยัง fail-open ให้ใช้งานต่อได้ (ดีกว่าบล็อกผู้ใช้ผิดพลาด)
      }

      return jsonRes({
        ok: true,
        quota: { ask: Math.max(0, limit - newUsed), used: newUsed, limit },
      });
    }

    return jsonRes({ ok: false, error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('quota handler error:', err.message);
    return jsonRes({ ok: false, error: err.message }, 500);
  }
}
