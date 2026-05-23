// api/ask.js — ค้นหากฎหมาย → Claude Sonnet (แม่นยำ)

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
      notice: 'นายทะเบียนสหกรณ์',
    }[filter || 'all'];

    // ── ดึง Knowledge จาก Vercel Blob ─────────────────
    let knowledgeText = '';
    try {
      const { list } = await import('@vercel/blob');
      const { blobs } = await list();
      const contents = await Promise.all(
        blobs
          .filter(b => b.pathname.endsWith('.csv') || b.pathname.endsWith('.txt'))
          .map(async (blob) => {
            const r = await fetch(blob.downloadUrl);
            const text = await r.text();
            return `[${blob.pathname}]\n${text}`;
          })
      );
      knowledgeText = contents.join('\n\n');
    } catch (e) {
      console.warn('Blob fetch failed:', e.message);
    }

    // ── ค้นหาเฉพาะส่วนที่เกี่ยวข้อง ──────────────────
    let context = '';
    if (knowledgeText) {
      context = searchRelevant(question, knowledgeText);
    }

    // ── System Prompt ──────────────────────────────────
    const system = `คุณคือ CoopLex AI ผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย
ตอบภาษาไทยที่เข้าใจง่าย อ้างอิงมาตราและกฎหมายเสมอ
ใช้ ## นำหน้าหัวข้อ ใช้ **ตัวหนา** สำหรับคำสำคัญ
ตอบให้ครบถ้วนสมบูรณ์ ห้ามตัดกลางคัน
ขอบเขต: ${filterLabel}`;

    // ── User Prompt ────────────────────────────────────
    let userPrompt = '';
    if (context) {
      userPrompt = `[ข้อมูลกฎหมายที่เกี่ยวข้องจากฐานข้อมูล]\n${context}\n\n[คำแนะนำ] ตอบจากข้อมูลข้างต้นเป็นหลัก ถ้าไม่มีให้ตอบจากความรู้ทั่วไป\n\n[คำถาม]\n${question}`;
    } else {
      userPrompt = `[คำถาม]\n${question}`;
    }

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
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: 'Claude: ' + data.error.message });

    const answer = data.content?.[0]?.text || '';
    return res.status(200).json({
      answer,
      provider: 'claude-sonnet-4',
      fromKnowledge: context.length > 0,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

// ── ค้นหาข้อความที่เกี่ยวข้อง ─────────────────────────
function searchRelevant(question, fullText) {
  const chunks = splitBySection(fullText);
  const keywords = extractKeywords(question);
  const scored = chunks
    .map(chunk => ({ text: chunk, score: scoreChunk(chunk, keywords) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  let result = '';
  for (const c of scored) {
    if ((result + c.text).length > 3000) break;
    result += c.text + '\n\n';
  }
  return result.trim();
}

function splitBySection(text) {
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((line.includes('มาตรา') || line.includes('หมวด')) && current.length > 100) {
      chunks.push(current.trim());
      current = line + '\n';
    } else {
      current += line + '\n';
      if (current.length > 2000) { chunks.push(current.trim()); current = ''; }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(c => c.length > 50);
}

function extractKeywords(question) {
  const nums = question.match(/(?:มาตรา\s*)?(\d+)/g) || [];
  const words = question.split(/[\s,。.]+/).filter(w => w.length > 2);
  return [...new Set([...nums, ...words])];
}

function scoreChunk(chunk, keywords) {
  let score = 0;
  const lower = chunk.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase()))
      score += /^\d+$/.test(kw) ? 3 : 1;
  }
  return score;
}
