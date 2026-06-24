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

    // ── ดึง Knowledge จาก Vercel Blob ──────────────────────────
    let knowledgeText = '';
    try {
      const { list } = await import('@vercel/blob');
      const token = process.env.BLOB_READ_WRITE_TOKEN;
      console.log('token:', token ? token.slice(0,20)+'...' : 'NOT SET');
      const { blobs } = await list({ limit: 100, token });
      console.log('Blob files:', blobs.length);

      const contents = await Promise.all(
        blobs
          .filter(b => b.pathname.endsWith('.txt'))
          .map(async (blob) => {
            try {
              const r = await fetch(blob.url, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
              });
              if (!r.ok) { console.warn('Failed:', blob.pathname, r.status); return ''; }
              const text = await r.text();
              console.log('Loaded:', blob.pathname, text.length, 'chars');
              return text.trim() ? '[' + blob.pathname + ']\n' + text : '';
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

    // ── ส่ง knowledge ทั้งหมดให้ Claude โดยไม่ filter ──────────
    // เหตุผล: ฐานข้อมูลมีไม่กี่ไฟล์ ขนาดรวม ~30k-50k chars เท่านั้น
    // (เล็กกว่า context window มาก) การ filter ก่อนด้วย keyword
    // มีความเสี่ยงสูงที่จะตัดไฟล์สำคัญออกถ้าคำถามไม่มี keyword ตรงเป๊ะ
    // เช่น "หลักเกณฑ์การตั้งค่าเผื่อหนี้สงสัยจะสูญ" ไม่มีคำว่า
    // "ระเบียบ/คำแนะนำ/ประกาศ" เลย ทำให้ needAll=true แล้วไฟล์ที่ถูกต้อง
    // แข่งคะแนนแพ้ไฟล์อื่นเพราะค้นแค่ 500 ตัวอักษรแรกของแต่ละไฟล์
    // ส่งทั้งหมดเลยปลอดภัยกว่า ต้นทุนเพิ่มขึ้นเล็กน้อยแต่ไม่พลาดไฟล์สำคัญ
    let context = '';
    let usedFiles = [];
    if (knowledgeText) {
      const fileBlocks = knowledgeText.split(/(?=\[[^\]]+\.txt\])/).filter(b => b.trim());

      for (const block of fileBlocks) {
        const nameMatch = block.match(/^\[([^\]]+\.txt)\]/);
        const fileName  = nameMatch ? nameMatch[1] : 'unknown.txt';
        context += '\n\n' + block;
        usedFiles.push(fileName);
      }

      console.log('[ask] Sending ALL files (no filtering):', usedFiles.length, 'files,', context.length, 'chars');
      console.log('[ask] Files:', usedFiles.join(', '));
    }

    /* ── Hybrid filtering (ปิดใช้งานไว้ — เก็บไว้เผื่อ knowledge โตขึ้นมากในอนาคต) ──
    // ถ้าวันหน้าไฟล์รวมกันเกิน ~150k chars ค่อยพิจารณาเปิดใช้ใหม่
    // พร้อมแก้ไขให้ค้นทั้งไฟล์ ไม่ใช่แค่ 500 ตัวอักษรแรก
    if (false) {
      // จำแนกประเภทคำถาม
      const q = question.toLowerCase();
      const needLaw      = q.includes('มาตรา') || q.includes('พ.ร.บ') || q.includes('บัญญัติ');
      const needRegs     = q.includes('กฎกระทรวง') || q.includes('ระเบียบ') || q.includes('ข้อบังคับ');
      const needNotice   = q.includes('คำแนะนำ') || q.includes('ประกาศ') || q.includes('นายทะเบียน')
                        || q.includes('เงินกู้') || q.includes('ดอกเบี้ย') || q.includes('ร้อยละ')
                        || q.includes('สินเชื่อ') || q.includes('ชำระหนี้') || q.includes('หนี้')
                        || q.includes('เงินเหลือสุทธิ') || q.includes('หลักเกณฑ์');
      const needTemplate = q.includes('ร่างข้อบังคับ') || q.includes('template') || q.includes('ตัวอย่าง');
      const needAll      = !needLaw && !needRegs && !needNotice && !needTemplate;

      // priority score ต่อไฟล์ตาม keyword
      const keywords = extractKeywords(question);

      const scored = fileBlocks.map(block => {
        const nameMatch = block.match(/^\[([^\]]+\.txt)\]/);
        const fileName  = nameMatch ? nameMatch[1].toLowerCase() : '';
        const fileText  = block.replace(/^\[[^\]]+\.txt\]\n?/, '');

        // ── ประเภทไฟล์ ──
        const isPRB      = fileName.includes('พระราชบัญญัติ') || fileName.includes('2542');
        const isMinReg   = /^\d+-กฎกระทรวง/.test(fileName) || fileName.includes('กฎกระทรวง');
        const isNotice   = /^\d+_คำแนะนำ/.test(fileName) || fileName.includes('คำแนะนำ');
        const isAnnounce = /^\d+_ประกาศ/.test(fileName)   || fileName.includes('ประกาศ');
        const isRegCoop  = /^\d+-/.test(fileName) && !isMinReg;  // ระเบียบนายทะเบียน
        const isDraftReg = fileName.includes('ระเบียบ') && !/^\d+/.test(fileName);

        // ── relevance score ──
        let score = 0;

        // match ประเภทคำถาม
        if (needAll)      score += 10;
        if (needLaw      && isPRB)      score += 50;
        if (needRegs     && isMinReg)   score += 40;
        if (needNotice   && (isNotice || isAnnounce || isRegCoop)) score += 40;
        if (needTemplate && isDraftReg) score += 40;

        // keyword score (เฉพาะชื่อไฟล์ + ข้อความ 500 ตัวแรก)
        const sample = fileName + ' ' + fileText.slice(0, 500);
        for (const kw of keywords) {
          if (kw.length > 2 && sample.includes(kw)) score += 3;
        }

        // พ.ร.บ. มักจำเป็นเสมอ
        if (isPRB) score += 15;

        return { fileName, fileText, score, chars: fileText.length };
      });

      // เรียงคะแนน + รับไฟล์จนถึง 35,000 chars
      scored.sort((a, b) => b.score - a.score);
      let totalChars = 0;
      const MAX_CONTEXT = 35000;

      for (const f of scored) {
        if (f.score === 0) continue;
        if (totalChars + f.chars > MAX_CONTEXT) {
          // ถ้าไฟล์ใหญ่เกิน ตัดเอาแค่ส่วนแรก
          const remaining = MAX_CONTEXT - totalChars;
          if (remaining > 500) {
            context += '\n\n[' + f.fileName + '] (บางส่วน)\n' + f.fileText.slice(0, remaining);
            usedFiles.push(f.fileName + '(partial)');
            totalChars += remaining;
          }
          break;
        }
        context += '\n\n[' + f.fileName + ']\n' + f.fileText;
        usedFiles.push(f.fileName);
        totalChars += f.chars;
      }

      console.log('Hybrid files selected:', usedFiles.length, '/', fileBlocks.length);
      console.log('Files:', usedFiles.join(', '));
      console.log('Context chars:', totalChars);
    }
    */ // ── จบ Hybrid filtering ที่ปิดใช้งานไว้ ──────────────────

    // ── System Prompt ──────────────────────────────────
    const system = `คุณคือ CoopLex AI ผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย

[แหล่งข้อมูลในฐานข้อมูล — ใช้อ้างอิงให้ถูกประเภท]
1. พ.ร.บ.สหกรณ์ 2542 — กฎหมายหลัก มาตราต่างๆ
2. กฎกระทรวง กสส. — ออกตาม พ.ร.บ.สหกรณ์
3. ระเบียบนายทะเบียนสหกรณ์ — หลักเกณฑ์ปฏิบัติ เช่น ระเบียบว่าด้วยสมาชิกสมทบ
4. คำแนะนำนายทะเบียนสหกรณ์ — แนวทางปฏิบัติ เช่น คำแนะนำเรื่องการให้เงินกู้อย่างรับผิดชอบและเป็นธรรม
5. ประกาศนายทะเบียนสหกรณ์ — ประกาศหลักเกณฑ์ต่างๆ
เมื่อตอบเรื่องเงินกู้/สินเชื่อ ให้ค้นหาจาก "คำแนะนำนายทะเบียนสหกรณ์" และ "ประกาศนายทะเบียนสหกรณ์" ก่อนเสมอ

[กฎเหล็ก — เรื่องเลขมาตรา/ข้อ ห้ามผิดพลาดเด็ดขาด]
- ห้ามจำเลขมาตราจากความจำตัวเอง หรือจากตัวอย่างใดๆ ก่อนหน้านี้ในบทสนทนา
- ทุกครั้งที่จะอ้างเลขมาตราหรือเลขข้อ ต้องคัดมาจากข้อความจริงในฐานข้อมูลที่ให้ไว้ด้านล่างเท่านั้น
  เช่น ถ้าในฐานข้อมูลเขียนว่า "มาตรา 60 ..." ให้อ้างว่ามาตรา 60 ห้ามเปลี่ยนเป็นเลขอื่นไม่ว่าด้วยเหตุผลใด
- ถ้าหาเลขมาตรา/ข้อที่แน่ชัดในฐานข้อมูลไม่ได้ ให้บอกเนื้อหาแล้วระบุว่า "ไม่พบเลขมาตราที่แน่ชัด กรุณาตรวจสอบจากต้นฉบับ"
  ดีกว่าเดาเลขมาตราที่ไม่แน่ใจ

[ลำดับการตอบ — ต้องปฏิบัติตามลำดับนี้เท่านั้น]
ขั้น 1: ค้นหาคำตอบจาก [ฐานข้อมูลกฎหมายสหกรณ์] ด้านล่างเท่านั้น
ขั้น 2: ถ้าพบ → ตอบพร้อมอ้างอิงชื่อไฟล์และเลขมาตรา/ข้อ "ตามที่ปรากฏในข้อความจริง" ห้ามดัดแปลง
ขั้น 3: ถ้าไม่พบในฐานข้อมูลเลย → ตอบว่า "ไม่พบข้อมูลในฐานข้อมูล กรุณาตรวจสอบเพิ่มเติมที่ www.cpd.go.th (กรมส่งเสริมสหกรณ์)" ห้ามคาดเดาหรือแต่งเติมเด็ดขาด
อ้างอิงแหล่งที่มาทุกข้อ ระบุชื่อไฟล์จากฐานข้อมูลด้วยถ้าทราบ เช่น (มาตรา XX พ.ร.บ.สหกรณ์ 2542 — ชื่อไฟล์.txt)

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
      userPrompt = [
        `[ฐานข้อมูลกฎหมายสหกรณ์ที่เกี่ยวข้อง (${usedFiles.length} ไฟล์)]`,
        context.trim(),
        ``,
        `[คำแนะนำ] ตอบจากข้อมูลในฐานข้อมูลข้างต้นเป็นหลัก อ้างอิงชื่อไฟล์และมาตรา/ข้อ`,
        ``,
        `[คำถาม]`,
        question,
      ].join('\n');
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
        model:      'claude-sonnet-4-6',
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

function toThaiNumerals(str) {
  const map = {'0':'๐','1':'๑','2':'๒','3':'๓','4':'๔','5':'๕','6':'๖','7':'๗','8':'๘','9':'๙'};
  return String(str).replace(/[0-9]/g, d => map[d]);
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
