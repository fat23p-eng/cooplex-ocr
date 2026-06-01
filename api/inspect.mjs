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

    // ── ดึง Knowledge จาก Vercel Blob (Server-side with token) ──
    let templateText = '', lawText = '', checklistText = '';
    try {
      const { list } = await import('@vercel/blob');
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      const { blobs } = await list({ limit: 100, token });

      const coopKeyword = coopType === 'credit' ? 'เครดิต' : 'ออมทรัพย์';
      await Promise.all(blobs
        .filter(b => b.pathname.endsWith('.txt'))
        .map(async (blob) => {
          try {
            const r = await fetch(blob.url, {
              headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!r.ok) { console.warn('Fetch failed:', blob.pathname, r.status); return; }
            const text = await r.text();
            const n = blob.pathname.toLowerCase();
            const isTemplate = n.includes('template') || n.includes(coopKeyword);
            const isOtherTemplate = n.includes('template') &&
              (coopType === 'credit' ? n.includes('ออมทรัพย์') : n.includes('เครดิต'));
            if (isOtherTemplate) {
              // ข้าม template ของประเภทอื่น
              console.log('Skip other-type template:', blob.pathname);
              return;
            }
            if (isTemplate) {
              templateText += text + '\n\n';
              console.log('Template loaded:', blob.pathname, text.length, 'chars');
            } else if (n.includes('checklist')) {
              checklistText += text + '\n\n';
            } else {
              lawText += text + '\n\n';
              console.log('Law loaded:', blob.pathname, text.length, 'chars');
            }
          } catch(e) { console.warn('Error:', blob.pathname, e.message); }
        })
      );
      console.log('Template:', templateText.length, 'Law:', lawText.length, 'Checklist:', checklistText.length);
    } catch (e) {
      console.warn('Blob fetch failed:', e.message);
    }

    // ── สร้าง System Prompt ────────────────────────────
    const system = `คุณคือผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย ทำหน้าที่ตรวจสอบข้อบังคับ${typeLabel}${sizeLabel ? ' ' + sizeLabel : ''}
วิเคราะห์เอกสารอย่างละเอียดและรอบคอบ โดยตรวจสอบ 3 ชั้น:

ชั้นที่ 1: เทียบกับร่างข้อบังคับมาตรฐาน (Template) ทีละข้อ
ชั้นที่ 2: เทียบกับ พ.ร.บ.สหกรณ์ พ.ศ.2542 และฉบับแก้ไข
ชั้นที่ 3: เทียบกับระเบียบนายทะเบียนสหกรณ์ที่เกี่ยวข้อง

[กฎการตรวจที่ต้องปฏิบัติอย่างเคร่งครัด]
1. ตรวจจากข้อมูลใน [ร่างข้อบังคับมาตรฐาน] และ [กฎหมายที่เกี่ยวข้อง] เท่านั้น
2. ห้ามมโนหรือสร้างข้อมูลขึ้นมาเองเด็ดขาด
3. ถ้าไม่มีข้อมูลในฐานข้อมูลให้ระบุว่า "ไม่มีข้อมูลในฐานข้อมูล ควรตรวจสอบเพิ่มเติม"
4. ห้ามระบุว่าขัดกฎหมายโดยไม่มีหลักฐานชัดเจนจากเอกสารที่ได้รับ
5. ตอบกระชับ แต่ละรายการไม่เกิน 1 ประโยค

[หลักการตีความกฎหมายสหกรณ์ที่ถูกต้อง]
1. คำว่า "สมาชิก" หมายถึงสมาชิกสามัญเท่านั้น ยกเว้นระบุชัดว่า "สมาชิกสมทบ"
2. สมาชิกสมทบมีข้อจำกัดตาม ม.41 เฉพาะ 4 ข้อนี้เท่านั้น:
   - ห้ามนับชื่อเป็นองค์ประชุมในที่ประชุมใหญ่
   - ห้ามออกเสียงในเรื่องใดๆ
   - ห้ามเป็นกรรมการดำเนินการ
   - ห้ามกู้ยืมเงินเกินกว่าเงินฝากและทุนเรือนหุ้นของตนจากสหกรณ์
3. ม.41 ไม่ได้ห้ามเรื่องอื่นนอกจาก 4 ข้อข้างต้น ห้ามตีความเพิ่มเติมเองเด็ดขาด
4. สิทธิและหน้าที่สมาชิกสมทบนอกจาก 4 ข้อข้างต้น ให้เป็นไปตามข้อบังคับ
   โดยความเห็นชอบของนายทะเบียนสหกรณ์
5. ถ้าร่างสอดคล้อง Template มาตรฐานกรมส่งเสริมสหกรณ์ ให้ถือว่าถูกต้อง

ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น
รูปแบบผลลัพธ์แต่ละรายการ:
- status: "ถูกต้อง" | "มีปัญหา" | "ควรตรวจสอบ"
- detail: อธิบายกระชับ 1 ประโยค อ้างอิงมาตราถ้ามี
- suggestion: คำแนะนำสั้นๆ (ถ้าจำเป็น)
JSON format:
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
      parts.push(`[ร่างข้อบังคับมาตรฐาน ${typeLabel} ${sizeLabel}]\n${templateText.slice(0, 18000)}`);
    } else {
      parts.push(`[หมายเหตุ] ไม่พบ Template สำหรับ ${typeLabel} ${sizeLabel} ในฐานข้อมูล ให้ใช้ความรู้จาก พ.ร.บ.สหกรณ์แทน`);
    }

    if (lawText) {
      parts.push(`[กฎหมายที่เกี่ยวข้อง]\n${lawText.slice(0, 12000)}`);
    }

    parts.push(`[ข้อบังคับที่ต้องการตรวจสอบ]\n${docText.slice(0, 20000)}`);

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
        max_tokens: 3000,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: 'Claude: ' + data.error.message });

    const raw = data.content?.[0]?.text || '';
    console.log('Raw response length:', raw.length, 'chars');
    console.log('Raw preview:', raw.slice(0, 200));
    let result;
    try {
      const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      result = JSON.parse(cleaned);
    } catch(parseErr) {
      console.error('JSON parse error:', parseErr.message);
      console.error('Raw (first 500):', raw.slice(0, 500));
      // ถ้า JSON ตัดกลางคัน ลอง extract เฉพาะส่วนที่สมบูรณ์
      const jsonStart = raw.indexOf('{');
      if (jsonStart !== -1) {
        try {
          // หา JSON ที่สมบูรณ์โดยนับ braces
          let depth = 0, end = -1;
          for (let i = jsonStart; i < raw.length; i++) {
            if (raw[i] === '{') depth++;
            else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
          if (end !== -1) result = JSON.parse(raw.slice(jsonStart, end + 1));
        } catch(e2) { console.error('Partial JSON also failed:', e2.message); }
      }
      if (!result) {
        result = {
          score: 60, coopType: typeLabel, coopSize: sizeLabel,
          summary: 'ไม่สามารถประมวลผลได้ครบถ้วน กรุณาลองใหม่อีกครั้ง',
          templateCheck: [], complete: [], conflict: [],
          missing: [], risk: ['ไม่สามารถประมวลผล JSON ได้ครบถ้วน'],
          suggest: ['กรุณาลองตรวจสอบใหม่อีกครั้ง'],
          expert: raw.slice(0, 500),
        };
      }
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
