// api/verify-slip.js — ตรวจสลิปด้วย Claude Vision + เพิ่ม quota ใน Vercel Blob
// ✅ เปลี่ยนจาก KV → Blob (project ไม่มี KV ผูกไว้ มีแค่ knowledge-public Blob Store)
// ✅ ใช้ token เดียวกับ ask.mjs/inspect.mjs/quota.mjs: knowledge_public_READ_WRITE_TOKEN
// ต้องตั้ง env: CLAUDE_API_KEY, knowledge_public_READ_WRITE_TOKEN

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { slipBase64, userId, action, expectedAmount } = req.body;
    if (!slipBase64) return res.status(400).json({ error: 'Missing slipBase64' });
    if (!userId)     return res.status(400).json({ error: 'Missing userId' });

    // ── 1. ตรวจสลิปด้วย Claude Vision ──────────────────
    const vRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 300,
        system: `คุณคือระบบตรวจสลิปโอนเงิน PromptPay อัตโนมัติ
ดูรูปสลิปแล้วตอบ JSON เท่านั้น ห้ามมีข้อความอื่น
รูปแบบ: {"valid": true/false, "amount": 0, "date": "", "ref": "", "reason": ""}
- valid: true ถ้าเป็นสลิปโอนเงินจริง ไม่ใช่รูปปลอมหรือรูปอื่น
- amount: จำนวนเงิน (ตัวเลขเท่านั้น ไม่มี ฿ หรือ ,)
- date: วันที่โอน เช่น "2025-05-31"
- ref: เลขอ้างอิง/เลขที่รายการ
- reason: ถ้า valid=false ให้ระบุเหตุผลสั้นๆ`,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type:       'base64',
                media_type: slipBase64.startsWith('/9j/') ? 'image/jpeg' : 'image/png',
                data:       slipBase64,
              }
            },
            { type: 'text', text: 'ตรวจสลิปนี้และตอบ JSON' }
          ]
        }]
      })
    });

    const vData = await vRes.json();
    if (vData.error) {
      console.error('Claude Vision error:', vData.error);
      return res.status(500).json({ error: 'ตรวจสลิปไม่ได้: ' + vData.error.message });
    }

    let slip;
    try {
      const raw = vData.content[0].text.replace(/```json|```/g,'').trim();
      slip = JSON.parse(raw);
    } catch(e) {
      console.error('Parse slip JSON failed:', vData.content[0].text);
      return res.status(500).json({ error: 'อ่านผลตรวจสลิปไม่ได้' });
    }

    console.log('Slip result:', slip, 'userId:', userId, 'action:', action);

    // ── 2. ตรวจสอบความถูกต้อง ───────────────────────────
    if (!slip.valid) {
      return res.status(200).json({
        ok: false,
        reason: slip.reason || 'ไม่ใช่สลิปโอนเงินที่ถูกต้อง',
      });
    }

    // ตรวจจำนวนเงิน (tolerance ±1 บาท)
    const paid = parseFloat(slip.amount) || 0;
    const expected = parseFloat(expectedAmount) || 0;
    if (expected > 0 && Math.abs(paid - expected) > 1) {
      return res.status(200).json({
        ok: false,
        reason: `จำนวนเงินไม่ตรง (สลิปแสดง ฿${paid} แต่ต้องชำระ ฿${expected})`,
      });
    }

    // ── 3. ตรวจสลิปซ้ำ (กัน reuse) ─────────────────────
    const slipId  = (slip.ref || (slip.date + '_' + paid)).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const slipPath = `slips/${slipId}.json`;
    const existingSlip = await blobGetJSON(slipPath);
    if (existingSlip) {
      return res.status(200).json({
        ok: false,
        reason: 'สลิปนี้ถูกใช้ไปแล้ว กรุณาโอนใหม่',
      });
    }

    // ── 4. บันทึกสลิป + เพิ่ม quota ─────────────────────
    // บันทึกสลิปไว้กัน reuse (ไม่มี auto-expire แบบ KV TTL — แต่ path เฉพาะตัวกันชนกันได้)
    await blobSetJSON(slipPath, { userId, amount: paid, date: slip.date, usedAt: Date.now() });

    // กำหนด bonus ตาม action
    const bonusMap = {
      ask:  { ask: 15, inspect: 0, ocr: 0 },
      insp: { ask: 0,  inspect: 1, ocr: 0 },
      ocr:  { ask: 0,  inspect: 0, ocr: 1 },
    };
    const bonus = bonusMap[action] || bonusMap.ask;

    // ✅ เพิ่ม bonus quota ใน Blob — path เดียวกับที่ quota.mjs ต้องอ่าน (ดูหมายเหตุด้านล่าง)
    const bonusPath = `bonus/${userId}.json`;
    const current = (await blobGetJSON(bonusPath)) || { ask: 0, inspect: 0, ocr: 0 };

    const updated = {
      ask:     (current.ask     || 0) + (bonus.ask     || 0),
      inspect: (current.inspect || 0) + (bonus.inspect || 0),
      ocr:     (current.ocr     || 0) + (bonus.ocr     || 0),
      updatedAt: new Date().toISOString(),
    };

    await blobSetJSON(bonusPath, updated);

    console.log('Bonus quota updated:', userId, updated);

    return res.status(200).json({
      ok:     true,
      quota:  updated,
      slip:   { amount: paid, date: slip.date, ref: slip.ref },
      bonus,
    });

  } catch (err) {
    console.error('verify-slip error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── Vercel Blob helpers (แทน KV) ─────────────────────
// เก็บ "bonus" (โควต้าซื้อเพิ่ม) แยกจาก "daily quota" ใน quota.mjs
// path: bonus/{userId}.json  — ไม่ผูกกับวัน เพราะโบนัสที่จ่ายเงินซื้อไม่หมดอายุรายวัน
function getBlobToken() {
  return process.env.knowledge_public_READ_WRITE_TOKEN;
}

async function blobGetJSON(path) {
  const token = getBlobToken();
  if (!token) return null;
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ token, prefix: path });
    const match = blobs.find(b => b.pathname === path);
    if (!match) return null;
    const r = await fetch(match.url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.warn('blobGetJSON error:', path, e.message);
    return null;
  }
}

async function blobSetJSON(path, data) {
  const token = getBlobToken();
  if (!token) { console.warn('Blob token not set — cannot save', path); return false; }
  try {
    const { put } = await import('@vercel/blob');
    await put(path, JSON.stringify(data), {
      access: 'public',
      token,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return true;
  } catch (e) {
    console.warn('blobSetJSON error:', path, e.message);
    return false;
  }
}
