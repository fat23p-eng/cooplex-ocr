// api/inspect.js — ตรวจข้อบังคับ/ระเบียบ (จ่ายเงิน) → Claude Sonnet
// ใช้ Claude เพราะต้องการความแม่นยำสูง วิเคราะห์กฎหมายละเอียด

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { docText, inspectType } = req.body;
    if (!docText) return res.status(400).json({ error: 'Missing docText' });

    const typeLabel = {
      bylaw:  'ข้อบังคับสหกรณ์',
      reg:    'ระเบียบสหกรณ์',
      notice: 'คำสั่ง/ประกาศ',
    }[inspectType || 'bylaw'];

    const system = `คุณคือผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทยที่ตรวจสอบ${typeLabel}
วิเคราะห์เอกสารอย่างละเอียดและรอบคอบ เปรียบเทียบกับ พ.ร.บ.สหกรณ์ พ.ศ.2542 ฉบับแก้ไข
กฎกระทรวงที่เกี่ยวข้อง และระเบียบนายทะเบียนสหกรณ์
ตอบเป็น JSON เท่านั้น ห้ามมีข้อความอื่น:
{
  "score": 0-100,
  "summary": "สรุปภาพรวมเอกสาร 2-3 ประโยค",
  "complete": ["รายการที่ครบถ้วนตาม พ.ร.บ. พร้อมอ้างอิงมาตรา"],
  "conflict": ["ข้อขัดแย้งกับกฎหมาย พร้อมอ้างอิงมาตราที่ขัด"],
  "risk": ["จุดเสี่ยง/ช่องโหว่ที่ควรระวัง"],
  "suggest": ["คำแนะนำแก้ไขพร้อมตัวอย่างข้อความ"],
  "expert": "ความเห็นผู้เชี่ยวชาญ 4-5 ประโยค"
}`;

    // ใช้ Claude Sonnet (แม่นยำสูง)
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages: [{
          role:    'user',
          content: `${typeLabel}ที่ต้องการตรวจ:\n\n${docText.slice(0, 20000)}`,
        }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: 'Claude: ' + data.error.message });

    const raw = data.content?.[0]?.text || '';
    let result;
    try {
      result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      result = { score: 70, summary: raw, complete: [], conflict: [], risk: [], suggest: [], expert: raw };
    }

    return res.status(200).json({ result, provider: 'claude-sonnet-4' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
