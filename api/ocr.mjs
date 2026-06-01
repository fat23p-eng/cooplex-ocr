// api/ocr.js — Vercel Serverless Function
// ซ่อน Claude API Key ไว้ใน Environment Variable
// ผู้ใช้ไม่เห็น Key เลย ปลอดภัย 100%

export default async function handler(req, res) {
  // CORS — อนุญาตทุก origin (แก้เป็น domain ของคุณได้)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { imageBase64, pageNum } = req.body;

    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    // เรียก Claude API (Key อยู่ใน Vercel Environment Variable)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: `คุณคือผู้ถอดข้อความจากเอกสารราชการไทย
งาน: ถอดข้อความทั้งหมดในรูปภาพให้ครบถ้วนและแม่นยำ
กฎ:
1. ถอดข้อความทุกตัวอักษร ห้ามตัดทอนหรือสรุป
2. รักษาโครงสร้างเดิม เช่น ข้อ 1 ข้อ 2 หมวด มาตรา
3. ถ้าเป็นหัวข้อใหญ่ให้ขึ้นบรรทัดใหม่
4. ถ้าอ่านไม่ออกให้ใส่ [อ่านไม่ออก] แทน
5. ตอบเฉพาะข้อความที่ถอดได้เท่านั้น ไม่ต้องมีคำอธิบาย`,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type:       'base64',
                media_type: imageBase64.startsWith('/9j/') ? 'image/jpeg' : 'image/png',
                data:       imageBase64,
              }
            },
            { type: 'text', text: 'ถอดข้อความทั้งหมดในรูปนี้' }
          ]
        }]
      })
    });

    const data = await response.json();

    // กรณี Claude API error (rate limit, invalid key ฯลฯ)
    if (data.error) {
      console.error('Claude API error:', data.error);
      return res.status(500).json({ error: data.error.message });
    }

    // กรณี content ว่าง หรือ stop_reason ผิดปกติ
    if (!data.content || !data.content[0] || !data.content[0].text) {
      console.error('Empty response:', JSON.stringify(data).slice(0, 200));
      return res.status(500).json({ error: 'Claude ไม่ส่งข้อความกลับมา (stop_reason: ' + (data.stop_reason||'unknown') + ')' });
    }

    // กรณี image ใหญ่เกิน Claude limit (~5MB base64)
    const imageSizeKB = Math.round(imageBase64.length * 0.75 / 1024);
    if (imageSizeKB > 4800) {
      console.warn('Large image:', imageSizeKB, 'KB — อาจช้าหรือ error');
    }

    console.log('OCR page', pageNum, '— chars:', data.content[0].text.length, '| image:', imageSizeKB, 'KB | stop:', data.stop_reason);

    return res.status(200).json({
      text:    data.content[0].text,
      pageNum: pageNum || 0,
    });

  } catch (err) {
    console.error('OCR handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
