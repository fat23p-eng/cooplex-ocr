// api/ask.js — ค้นหากฎหมาย (ฟรี) → Gemini 2.5 Flash

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, filter } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    const filterLabel = {
      all:    'ทุกหมวดกฎหมาย',
      law:    'พ.ร.บ.สหกรณ์',
      reg:    'กฎกระทรวง',
      notice: 'ระเบียบ/คำแนะนำนายทะเบียนสหกรณ์',
    }[filter || 'all'];

    const system = `คุณคือ CoopLex AI ผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย
ตอบภาษาไทยที่เข้าใจง่าย อ้างอิงมาตราและกฎหมายเสมอ
ใช้ ## นำหน้าหัวข้อ ใช้ **ตัวหนา** สำหรับคำสำคัญ
ตอบให้ครบถ้วนสมบูรณ์ทุกครั้ง ห้ามตัดคำตอบกลางคัน
ขอบเขต: ${filterLabel}`;

    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: question }] }],
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.7,
        },
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: 'Gemini: ' + data.error.message });

    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({ answer, provider: 'gemini-2.5-flash' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
