// api/ask.js — ค้นหากฎหมาย → ดึงจาก Vercel Blob → Gemini ตอบ

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { question, filter } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });

    // ── ดึง Knowledge จาก Vercel Blob ─────────────────
    let knowledgeText = '';
    try {
      const { list } = await import('@vercel/blob');
      const { blobs } = await list();

      // ดึงทุกไฟล์ในภาษาไทย (csv, txt)
      const files = blobs.filter(b =>
        b.pathname.endsWith('.csv') ||
        b.pathname.endsWith('.txt')
      );

      // ดึงเนื้อหาทุกไฟล์
      const contents = await Promise.all(
        files.map(async (blob) => {
          const r = await fetch(blob.downloadUrl);
          const text = await r.text();
          return `[ไฟล์: ${blob.pathname}]\n${text}`;
        })
      );
      knowledgeText = contents.join('\n\n');
    } catch (e) {
      console.warn('Blob fetch failed:', e.message);
    }

    // ── ค้นหาข้อความที่เกี่ยวข้อง ─────────────────────
    let context = '';
    if (knowledgeText) {
      context = searchRelevant(question, knowledgeText);
    }

    // ── สร้าง Prompt ───────────────────────────────────
    const filterLabel = {
      all:    'ทุกหมวดกฎหมาย',
      law:    'พ.ร.บ.สหกรณ์',
      reg:    'กฎกระทรวง',
      notice: 'ระเบียบ/คำแนะนำนายทะเบียนสหกรณ์',
    }[filter || 'all'];

    const promptParts = [];

    promptParts.push(`[บทบาท]
คุณคือ CoopLex AI ผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย
ตอบภาษาไทยที่เข้าใจง่าย อ้างอิงมาตราและกฎหมายเสมอ
ใช้ ## นำหน้าหัวข้อ ใช้ **ตัวหนา** สำหรับคำสำคัญ
ตอบให้ครบถ้วนสมบูรณ์ ห้ามตัดกลางคัน
ขอบเขต: ${filterLabel}`);

    if (context) {
      promptParts.push(`[ข้อมูลกฎหมายที่เกี่ยวข้อง]
${context}

[คำแนะนำ]
ให้ตอบจากข้อมูลกฎหมายข้างต้นเป็นหลัก
ถ้าข้อมูลในเอกสารไม่เพียงพอ ให้แจ้งว่า "ไม่พบข้อมูลในฐานข้อมูล" แล้วตอบจากความรู้ทั่วไปแทน`);
    } else {
      promptParts.push(`[คำแนะนำ]
ไม่พบฐานข้อมูล ให้ตอบจากความรู้ด้านกฎหมายสหกรณ์ไทยทั่วไป`);
    }

    promptParts.push(`[คำถาม]\n${question}`);

    const fullPrompt = promptParts.join('\n\n');

    // ── เรียก Gemini ───────────────────────────────────
    const apiKey = process.env.GEMINI_API_KEY;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        generationConfig: {
          maxOutputTokens: 1500,
          temperature: 0.3,
        },
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: 'Gemini: ' + data.error.message });

    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const hasKnowledge = context.length > 0;

    return res.status(200).json({
      answer,
      provider: 'gemini-2.5-flash',
      fromKnowledge: hasKnowledge,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ── ค้นหาข้อความที่เกี่ยวข้องกับคำถาม ────────────────
function searchRelevant(question, fullText) {
  // แยกเป็นก้อนๆ ตามมาตรา
  const chunks = splitBySection(fullText);

  // ดึงคำสำคัญจากคำถาม
  const keywords = extractKeywords(question);

  // หาก้อนที่เกี่ยวข้อง
  const scored = chunks.map(chunk => ({
    text: chunk,
    score: scoreChunk(chunk, keywords),
  }));

  // เรียงตาม score สูงสุด
  scored.sort((a, b) => b.score - a.score);

  // เอา top 5 ที่เกี่ยวข้อง
  const relevant = scored
    .filter(c => c.score > 0)
    .slice(0, 3)
    .map(c => c.text);

  // จำกัดขนาดรวมไม่เกิน 8000 ตัวอักษร
  let result = '';
  for (const chunk of relevant) {
    if ((result + chunk).length > 3000) break;
    result += chunk + '\n\n';
  }

  return result.trim();
}

function splitBySection(text) {
  // แยกตามมาตรา หรือแยกตามหมวด
  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    // ขึ้นก้อนใหม่เมื่อเจอ "มาตรา" หรือ "หมวด"
    if ((line.includes('มาตรา') || line.includes('หมวด')) && current.length > 100) {
      chunks.push(current.trim());
      current = line + '\n';
    } else {
      current += line + '\n';
      // ถ้าก้อนยาวเกินไปก็แยก
      if (current.length > 2000) {
        chunks.push(current.trim());
        current = '';
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter(c => c.length > 50);
}

function extractKeywords(question) {
  // ดึงคำสำคัญ: ตัวเลข มาตรา คำนาม
  const keywords = [];

  // หาตัวเลขมาตรา (เช่น "มาตรา 50" หรือ "50")
  const numMatches = question.match(/(?:มาตรา\s*)?(\d+)/g);
  if (numMatches) keywords.push(...numMatches);

  // หาคำสำคัญยาว > 2 ตัวอักษร
  const words = question.split(/[\s,。.]+/).filter(w => w.length > 2);
  keywords.push(...words);

  return [...new Set(keywords)];
}

function scoreChunk(chunk, keywords) {
  let score = 0;
  const lowerChunk = chunk.toLowerCase();
  for (const kw of keywords) {
    const lowerKw = kw.toLowerCase();
    if (lowerChunk.includes(lowerKw)) {
      // ถ้าเป็นเลขมาตรา ให้คะแนนสูงกว่า
      score += /^\d+$/.test(kw) ? 3 : 1;
    }
  }
  return score;
}
