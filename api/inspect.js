// api/inspect.js — ตรวจข้อบังคับ/ระเบียบ → Claude Sonnet (แม่นยำ)
// ตรวจ 3 ชั้น: Template + พ.ร.บ. + ระเบียบนายทะเบียน

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { docText, coopType, coopSize } = req.body;
    if (!docText) return res.status(400).json({ error: 'Missing docText' });

    // ── ประเภทสหกรณ์ ──────────────────────────────────
    const typeLabel = {
      saving: 'สหกรณ์ออมทรัพย์',
      credit: 'สหกรณ์เครดิตยูเนียน',
    }[coopType || 'saving'];

    const sizeLabel = coopSize === 'large'
      ? 'ขนาดใหญ่ (ทุนดำเนินงาน ≥ 5,000 ล้านบาท)'
      : 'ขนาดเล็ก (ทุนดำเนินงาน < 5,000 ล้านบาท)';

    // ── ดึง Knowledge จาก Vercel Blob ─────────────────
    let templateText = '';
    let lawText = '';

    try {
      const { list, head } = await import('@vercel/blob');
      const { blobs } = await list();

      for (const blob of blobs) {
        const name = blob.pathname.toLowerCase();
        const r = await fetch(blob.downloadUrl);
        const text = await r.text();

        // Template ตรงประเภท+ขนาด
        if (coopType === 'saving' && coopSize === 'large' &&
          (name.includes('ออมทรัพย์') || name.includes('saving')) &&
          (name.includes('ใหญ่') || name.includes('large'))) {
          templateText = text;
        } else if (coopType === 'saving' && coopSize === 'small' &&
          (name.includes('ออมทรัพย์') || name.includes('saving')) &&
          (name.includes('เล็ก') || name.includes('small'))) {
          templateText = text;
        } else if (coopType === 'credit' && coopSize === 'large' &&
          (name.includes('เครดิต') || name.includes('credit')) &&
          (name.includes('ใหญ่') || name.includes('large'))) {
          templateText = text;
        } else if (coopType === 'credit' && coopSize === 'small' &&
          (name.includes('เครดิต') || name.includes('credit')) &&
          (name.includes('เล็ก') || name.includes('small'))) {
          templateText = text;
        }

        // กฎหมาย พ.ร.บ. + ระเบียบนายทะเบียน
        if (name.includes('พรบ') || name.includes('พระราชบัญญัติ') ||
          name.includes('law') || name.includes('ระเบียบนายทะเบียน')) {
          lawText += `\n\n[${blob.pathname}]\n${text}`;
        }
      }
    } catch (e) {
      console.warn('Blob fetch failed:', e.message);
    }

    // ── สร้าง System Prompt ────────────────────────────
    const system = `คุณคือผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย ทำหน้าที่ตรวจสอบข้อบังคับ${typeLabel}${sizeLabel ? ' ' + sizeLabel : ''}
วิเคราะห์เอกสารอย่างละเอียดและรอบคอบ โดยตรวจสอบ 3 ชั้น:

ชั้นที่ 1: เทียบกับร่างข้อบังคับมาตรฐาน (Template) ทีละข้อ
ชั้นที่ 2: เทียบกับ พ.ร.บ.สหกรณ์ พ.ศ.2542 และฉบับแก้ไข
ชั้นที่ 3: เทียบกับระเบียบนายทะเบียนสหกรณ์ที่เกี่ยวข้อง

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "score": 0-100,
  "coopType": "${typeLabel}",
  "coopSize": "${sizeLabel}",
  "summary": "สรุปภาพรวมเอกสาร 2-3 ประโยค",
  "templateCheck": [
    {"item": "ชื่อรายการ", "status": "ครบ/ขาด/ไม่ถูกต้อง", "detail": "รายละเอียด"}
  ],
  "complete": ["รายการที่ครบถ้วนตาม Template และ พ.ร.บ."],
  "conflict": ["ข้อขัดแย้งกับกฎหมาย พร้อมอ้างอิงมาตรา"],
  "missing": ["รายการที่ขาดหายไปจาก Template"],
  "risk": ["จุดเสี่ยง/ช่องโหว่ที่ควรระวัง"],
  "suggest": ["คำแนะนำแก้ไขพร้อมตัวอย่างข้อความ"],
  "expert": "ความเห็นผู้เชี่ยวชาญ 4-5 ประโยค"
}`;

    // ── สร้าง User Prompt ──────────────────────────────
    const parts = [];

    if (templateText) {
      parts.push(`[ร่างข้อบังคับมาตรฐาน ${typeLabel} ${sizeLabel}]\n${templateText.slice(0, 10000)}`);
    } else {
      parts.push(`[หมายเหตุ] ไม่พบ Template สำหรับ ${typeLabel} ${sizeLabel} ในฐานข้อมูล ให้ใช้ความรู้จาก พ.ร.บ.สหกรณ์แทน`);
    }

    if (lawText) {
      parts.push(`[กฎหมายที่เกี่ยวข้อง]\n${lawText.slice(0, 8000)}`);
    }

    parts.push(`[ข้อบังคับที่ต้องการตรวจสอบ]\n${docText.slice(0, 15000)}`);

    const userPrompt = parts.join('\n\n---\n\n');

    // ── เรียก Claude Sonnet ────────────────────────────
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: 'Claude: ' + data.error.message });

    const raw = data.content?.[0]?.text || '';
    let result;
    try {
      result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      result = {
        score: 70, coopType: typeLabel, coopSize: sizeLabel,
        summary: raw, templateCheck: [], complete: [],
        conflict: [], missing: [], risk: [], suggest: [], expert: raw,
      };
    }

    return res.status(200).json({
      result,
      hasTemplate: !!templateText,
      hasLaw: !!lawText,
      provider: 'claude-sonnet-4',
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
