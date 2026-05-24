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
      const { blobs } = await list({ limit: 100 });
      console.log('Blob files found:', blobs.length, blobs.map(b => b.pathname));

      const { download } = await import('@vercel/blob');
      const contents = await Promise.all(
        blobs
          .filter(b => {
            const p = b.pathname || '';
            return p.endsWith('.txt') || p.endsWith('.csv');
          })
          .map(async (blob) => {
            try {
              const { text } = await download(blob.url, { token: process.env.BLOB_READ_WRITE_TOKEN });
              const content = await text();
              console.log('Loaded:', blob.pathname, content.length, 'chars');
              return `[${blob.pathname}]\n${content}`;
            } catch (e) {
              console.warn('Fetch failed:', blob.pathname, e.message);
              return '';
            }
          })
      );
      knowledgeText = contents.filter(Boolean).join('\n\n');
      console.log('Total knowledge chars:', knowledgeText.length);
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

[กฎการตอบที่ต้องปฏิบัติอย่างเคร่งครัด]
1. ตอบจากข้อมูลใน [ข้อมูลกฎหมายที่เกี่ยวข้องจากฐานข้อมูล] เท่านั้นก่อน
2. ถ้าไม่มีข้อมูลในฐานข้อมูล ให้แจ้งว่า "ไม่พบในฐานข้อมูล" แล้วจึงตอบจากความรู้กฎหมายสหกรณ์ทั่วไป
3. ห้ามมโนหรือสร้างข้อมูลขึ้นมาเองเด็ดขาด
4. ถ้าไม่แน่ใจให้บอกว่า "ไม่แน่ใจ ควรตรวจสอบกับผู้เชี่ยวชาญ"
5. อ้างอิงมาตราและกฎหมายที่มาของข้อมูลเสมอ
6. ตอบกระชับตรงประเด็น ไม่เกิน 5-6 ย่อหน้า ห้ามตัดกลางคัน
7. จัดรูปแบบคำตอบดังนี้:
   - ขึ้นต้นด้วยสรุปสั้น 1-2 ประโยค
   - ใช้หัวข้อ **ตัวหนา** แบ่งเป็นหมวด
   - รายการย่อยใช้ - นำหน้า ติดกันไม่เว้นบรรทัด เช่น "- ข้อ 1\n- ข้อ 2\n- ข้อ 3"
   - ระบุ (มาตรา XX) กำกับท้ายทุกข้อที่อ้างอิงกฎหมาย
   - สรุปท้ายสั้นๆ 1 ประโยค
   - ห้ามใช้ ## หรือ ### นำหน้าหัวข้อ
   - ห้ามเว้นบรรทัดว่างระหว่าง bullet list

ขอบเขต: \${filterLabel}`;

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
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: 'Claude: ' + data.error.message });

    const answer = data.content?.[0]?.text || '';
    console.log('Context sent to Claude:', context.length, 'chars');
    console.log('Context preview:', context.slice(0, 300));
    return res.status(200).json({
      answer,
      provider: 'claude-sonnet-4',
      fromKnowledge: context.length > 0,
      debug_context_chars: context.length,
      debug_blob_chars: knowledgeText.length,
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

  // 1. Exact match: ถ้าถามมาตราเฉพาะ เช่น "มาตรา 41" → ดึง chunk นั้นก่อนเลย
  const matraMatch = question.match(/มาตรา\s*(\d+(?:\/\d+)?)/);
  const exactChunks = [];
  if (matraMatch) {
    const target = `มาตรา ${matraMatch[1]}`;
    for (const chunk of chunks) {
      // ต้องขึ้นต้นด้วย "มาตรา XX" หรือมีอยู่ใกล้ต้น chunk
      if (chunk.trimStart().startsWith(target) || chunk.slice(0, 30).includes(target)) {
        exactChunks.push({ text: chunk, score: 999 });
      }
    }
  }

  // 2. Keyword scoring สำหรับ chunk ที่เหลือ
  const scored = chunks
    .map(chunk => ({ text: chunk, score: scoreChunk(chunk, keywords) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);

  // รวม exact chunks ไว้หน้า แล้วตามด้วย keyword chunks (ไม่ซ้ำ)
  const exactTexts = new Set(exactChunks.map(c => c.text));
  const combined = [
    ...exactChunks,
    ...scored.filter(c => !exactTexts.has(c.text)),
  ].slice(0, 6);

  let result = '';
  for (const c of combined) {
    if ((result + c.text).length > 5000) break;
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
      if (current.length > 1000) { chunks.push(current.trim()); current = ''; }
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
  for (const kw of keywords) {
    // ค้นตรงๆ ไม่ lowercase เพราะภาษาไทยไม่มี case
    const count = (chunk.match(new RegExp(kw, 'g')) || []).length;
    if (count > 0) {
      if (/^\d+$/.test(kw)) score += count * 3;      // เลขมาตรา
      else if (kw.length >= 4) score += count * 2;   // คำยาว
      else score += count * 1;                        // คำสั้น
    }
  }
  return score;
}
