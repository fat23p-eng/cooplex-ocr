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

    // ── ดึง Knowledge จาก Vercel Blob (Server-side with token) ──
    let knowledgeText = '';
    try {
      const { list, head } = await import('@vercel/blob');
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      const { blobs } = await list({ limit: 100, token });
      console.log('Blob files:', blobs.length);

      const contents = await Promise.all(
        blobs
          .filter(b => b.pathname.endsWith('.txt'))
          .map(async (blob) => {
            try {
              // ดึงด้วย token ผ่าน Authorization header
              const r = await fetch(blob.url, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (!r.ok) {
                console.warn('Failed:', blob.pathname, r.status);
                return '';
              }
              const text = await r.text();
              console.log('Loaded:', blob.pathname, text.length);
              return `[${blob.pathname}]
${text}`;
            } catch(e) {
              console.warn('Error:', blob.pathname, e.message);
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
      // แยกแต่ละไฟล์ด้วย delimiter [ชื่อไฟล์.txt]
      const fileBlocks = knowledgeText.split(/(?=\[[^\]]+\.txt\])/);
      const allChunks = [];
      let keywords = extractKeywords(question);
      const matraMatch = question.match(/มาตรา\s*(\d+(?:\/\d+)?)/);

      // Special case: เพิ่ม keyword เฉพาะเรื่อง
      if (question.includes('ชุมนุมสหกรณ์') && !matraMatch) {
        keywords = [...keywords, 'หมวด 7', 'มาตรา 101', 'มาตรา 102', 'จัดตั้งชุมนุม'];
      }
      if (question.includes('ควบสหกรณ์') || question.includes('การควบ')) {
        keywords = [...keywords, 'หมวด 5', 'มาตรา 90', 'ควบเข้ากัน'];
      }
      if (question.includes('แยกสหกรณ์') || question.includes('การแยก')) {
        keywords = [...keywords, 'หมวด 6', 'มาตรา 96'];
      }
      if (question.includes('สมาชิกสมทบ')) {
        keywords = [...keywords, 'มาตรา 41', 'สมาชิกสมทบ', 'ผู้ตรวจสอบกิจการ'];
      }

      for (const block of fileBlocks) {
        if (!block.trim()) continue;
        // ดึงชื่อไฟล์
        const fileNameMatch = block.match(/^\[([^\]]+\.txt)\]/);
        const fileName = fileNameMatch ? fileNameMatch[1] : '';
        const fileText = block.replace(/^\[[^\]]+\.txt\]\n?/, '');

        // weight พิเศษตามลำดับความสำคัญ
        let fileBonus = 0;
        const fn = fileName.toLowerCase();
        if (fn.includes('พระราชบัญญัติ') || fn.includes('2542')) fileBonus = 20;
        else if (fn.includes('กฎกระทรวง')) fileBonus = 10;
        else if (fn.includes('ระเบียบ')) fileBonus = 5;
        else if (fn.includes('checklist')) fileBonus = 3;

        const chunks = splitBySection(fileText);
        for (const chunk of chunks) {
          // Exact match มาตรา
          if (matraMatch) {
            const target = `มาตรา ${matraMatch[1]}`;
            if (chunk.trimStart().startsWith(target) || chunk.slice(0, 50).includes(target)) {
              allChunks.push({ text: chunk, score: 999 + fileBonus });
              continue;
            }
          }
          const score = scoreChunk(chunk, keywords);
          if (score > 0) allChunks.push({ text: chunk, score: score + fileBonus });
        }
      }

      allChunks.sort((a, b) => b.score - a.score);
      const seen = new Set();
      for (const c of allChunks) {
        if (seen.has(c.text)) continue;
        seen.add(c.text);
        if ((context + c.text).length > 8000) break;
        context += c.text + '\n\n';
      }
    }
    console.log('Context sent to Claude:', context.length, 'chars');
    console.log('Context preview:', context.slice(0, 200));

    // ── System Prompt ──────────────────────────────────
    const system = `คุณคือ CoopLex AI ผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย

[ความรู้สำคัญที่ต้องจำ — ห้ามตอบผิด]
มาตรา 41 พ.ร.บ.สหกรณ์ 2542 — สมาชิกสมทบ:
- สมาชิกสมทบมีสิทธิและหน้าที่ตามที่กำหนดในข้อบังคับของสหกรณ์
- สมาชิกสมทบ "มีสิทธิ" ได้รับเลือกตั้งเป็นผู้ตรวจสอบกิจการได้ (ไม่ห้าม)
- สมาชิกสมทบ "ไม่มีสิทธิ" ออกเสียงลงคะแนนในที่ประชุมใหญ่
- สมาชิกสมทบ "ไม่มีสิทธิ" รับเลือกตั้งเป็นกรรมการดำเนินการหรือผู้จัดการ
ข้อสำคัญ: ผู้ตรวจสอบกิจการ ≠ กรรมการดำเนินการ สมาชิกสมทบเป็นผู้ตรวจสอบกิจการได้

[หลักการตอบ]
1. ตอบจาก [ข้อมูลกฎหมายที่เกี่ยวข้องจากฐานข้อมูล] เป็นหลัก ห้ามมโนหรือแต่งเติมข้อมูล
2. ถ้าไม่มีในฐานข้อมูล ให้แจ้งก่อนแล้วตอบจากความรู้กฎหมายสหกรณ์ทั่วไป
3. อ้างอิงแหล่งที่มาทุกข้อ เช่น (มาตรา 41 พ.ร.บ.สหกรณ์ 2542) หรือ (ข้อ 5 กฎกระทรวง 2567) หรือ (ระเบียบนายทะเบียนฯ ข้อ 3)

[รูปแบบคำตอบ — ปฏิบัติทุกครั้ง]
- สรุปสั้น 1-2 ประโยค ตอบตรงคำถามทันที
- แบ่งหัวข้อด้วย **ตัวหนา** เฉพาะเมื่อมีหลายประเด็น
- รายการย่อยใช้ - ติดกัน ไม่เว้นบรรทัดระหว่าง bullet
- ทุกข้อที่มาจากกฎหมายต้องระบุ (ที่มา) กำกับท้าย
- ถ้ามีหลายแหล่ง ให้ระบุครบทุกแหล่ง เช่น พ.ร.บ. + กฎกระทรวง + ระเบียบ
- ปิดท้ายด้วยสรุป 1 ประโยค
- ห้ามใช้ ## ### ห้ามเว้นบรรทัดว่างระหว่าง bullet
- ห้ามตัดคำตอบกลางคัน ให้ตอบให้ครบทุกประเด็นสำคัญ

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
        max_tokens: 1500,
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
