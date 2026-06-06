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

    // ── Hybrid: filter ไฟล์ตามประเภทคำถาม → ส่งทั้งไฟล์ ────────
    // ราคา: ~$0.077/ครั้ง (vs Full Context $0.40, RAG $0.03)
    // แม่นกว่า keyword chunk เพราะส่งทั้งไฟล์ ไม่ตัดข้อมูลออก
    let context = '';
    let usedFiles = [];
    if (knowledgeText) {
      // แยกไฟล์
      const fileBlocks = knowledgeText.split(/(?=\[[^\]]+\.txt\])/).filter(b => b.trim());

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

    // ── System Prompt ──────────────────────────────────
    const system = `คุณคือ CoopLex AI ผู้เชี่ยวชาญด้านกฎหมายสหกรณ์ไทย

[ความรู้สำคัญที่ต้องจำ — ห้ามตอบผิด]
มาตรา 41 พ.ร.บ.สหกรณ์ 2542 — สมาชิกสมทบ (ข้อความกฎหมายแท้จริง):
สหกรณ์ตามมาตรา 33/1 ทั้ง 7 ประเภท อาจรับสมาชิกสมทบได้ทุกประเภท ได้แก่:
(1) สหกรณ์การเกษตร
(2) สหกรณ์โครงการพัฒนาที่ดิน
(3) สหกรณ์ประมง
(4) สหกรณ์ออมทรัพย์
(5) สหกรณ์เครดิตยูเนี่ยน
(6) สหกรณ์ร้านค้า
(7) สหกรณ์บริการ
ข้อยกเว้นพิเศษ: สหกรณ์ออมทรัพย์ / เครดิตยูเนี่ยน / ร้านค้า ที่ตั้งอยู่ในสถานศึกษา สามารถรับผู้ศึกษาที่ยังไม่บรรลุนิติภาวะเป็นสมาชิกสมทบได้ (มาตรา 41 วรรคสอง)
สมาชิกสมทบต้องมีความสัมพันธ์กับสหกรณ์หรือสมาชิกสหกรณ์ตามหลักเกณฑ์ที่นายทะเบียนสหกรณ์ประกาศกำหนด
คุณสมบัติอื่น วิธีรับสมัคร การขาดจากสมาชิกภาพ ตลอดจนสิทธิและหน้าที่ของสมาชิกสมทบให้เป็นไปตามที่กำหนดในข้อบังคับโดยความเห็นชอบของนายทะเบียนสหกรณ์
การตอบเรื่องสมาชิกสมทบต้องอ้างอิงทั้ง พ.ร.บ.สหกรณ์ มาตรา 41 และระเบียบนายทะเบียนสหกรณ์ที่เกี่ยวข้องด้วยทุกครั้ง

[แหล่งข้อมูลในฐานข้อมูล — ใช้อ้างอิงให้ถูกประเภท]
1. พ.ร.บ.สหกรณ์ 2542 — กฎหมายหลัก มาตราต่างๆ
2. กฎกระทรวง กสส. — ออกตาม พ.ร.บ.สหกรณ์
3. ระเบียบนายทะเบียนสหกรณ์ — หลักเกณฑ์ปฏิบัติ เช่น ระเบียบว่าด้วยสมาชิกสมทบ
4. คำแนะนำนายทะเบียนสหกรณ์ — แนวทางปฏิบัติ เช่น คำแนะนำเรื่องการให้เงินกู้อย่างรับผิดชอบและเป็นธรรม
5. ประกาศนายทะเบียนสหกรณ์ — ประกาศหลักเกณฑ์ต่างๆ
เมื่อตอบเรื่องเงินกู้/สินเชื่อ ให้ค้นหาจาก "คำแนะนำนายทะเบียนสหกรณ์" และ "ประกาศนายทะเบียนสหกรณ์" ก่อนเสมอ

ระเบียบนายทะเบียนสหกรณ์ ข้อ 4 — คุณสมบัติ สิทธิ และการขาดสมาชิกภาพของสมาชิกสมทบ:

[4.1 คุณสมบัติ — แยกตามประเภทสหกรณ์]
(1) สหกรณ์ออมทรัพย์และสหกรณ์เครดิตยูเนียน:
    - บิดา มารดา คู่สมรส หรือบุตรที่บรรลุนิติภาวะของสมาชิก หรือ
    - บุคคลในองค์กร/หน่วยงานที่ขาดคุณสมบัติจะสมัครเป็นสมาชิกตามข้อบังคับ
(2) สหกรณ์การเกษตร สหกรณ์นิคม และสหกรณ์ประมง:
    - บุคคลที่อาศัยอยู่ในท้องที่ดำเนินงานหรือพื้นที่รับสมาชิกของสหกรณ์ แต่ขาดคุณสมบัติเฉพาะด้านอาชีพ
(3) สหกรณ์บริการและสหกรณ์ร้านค้า:
    - บิดา มารดา คู่สมรส หรือบุตรที่บรรลุนิติภาวะของสมาชิกเท่านั้น

[4.2 สิทธิของสมาชิกสมทบ — ต้องกำหนดในข้อบังคับอย่างชัดเจน]
- ถ้าข้อบังคับไม่กำหนดสิทธิไว้ = สมาชิกสมทบไม่ได้รับสิทธิใดๆ
(1) ถือหุ้น: อย่างน้อย 1 หุ้น แต่ไม่เกิน 1/5 ของหุ้นที่ชำระแล้วทั้งหมด รับเงินปันผลอัตราเดียวกับสมาชิก
(2) เงินเฉลี่ยคืน: ได้รับตามส่วนธุรกิจในอัตราเดียวกับสมาชิก
(3) ฝากเงิน: ฝากได้ทั้งออมทรัพย์และประจำ
(4) กู้เงิน: กู้ได้แต่ไม่เกินมูลค่าหุ้น + เงินฝากของสมาชิกสมทบรายนั้น

[4.3 การขาดจากสมาชิกภาพ]
- ถ้าสมาชิก (ที่เป็นผู้เกี่ยวข้องกับสมาชิกสมทบตาม 4.1(1) หรือ (3)) ขาดจากสมาชิกภาพด้วยเหตุใดก็ตาม → สมาชิกสมทบรายนั้นต้องขาดจากสมาชิกภาพด้วยโดยอัตโนมัติ
สมาชิกสมทบต้องมีความสัมพันธ์กับสหกรณ์หรือสมาชิกสหกรณ์ตามหลักเกณฑ์ที่นายทะเบียนสหกรณ์ประกาศกำหนด
คุณสมบัติอื่น วิธีรับสมัคร การขาดจากสมาชิกภาพ ตลอดจนสิทธิและหน้าที่ของสมาชิกสมทบให้เป็นไปตามที่กำหนดในข้อบังคับโดยความเห็นชอบของนายทะเบียนสหกรณ์

สิ่งที่กฎหมาย "ห้าม" สหกรณ์ให้สิทธิแก่สมาชิกสมทบ (มีเพียง 4 เรื่อง):
1. ห้ามนับชื่อสมาชิกสมทบเข้าเป็นองค์ประชุมในการประชุมใหญ่
2. ห้ามออกเสียงในเรื่องใดๆ
3. ห้ามเป็นกรรมการดำเนินการ
4. ห้ามกู้ยืมเงินเกินกว่าเงินฝากและทุนเรือนหุ้นของตนเองจากสหกรณ์

ข้อสำคัญ: กฎหมาย "ไม่ได้ห้าม" สมาชิกสมทบเป็นผู้ตรวจสอบกิจการ
ดังนั้น สมาชิกสมทบ "มีสิทธิ" ได้รับเลือกเป็นผู้ตรวจสอบกิจการได้ตามที่ข้อบังคับกำหนด
ผู้ตรวจสอบกิจการ ≠ กรรมการดำเนินการ เป็นคนละตำแหน่งกัน

[ลำดับการตอบ — ต้องปฏิบัติตามลำดับนี้เท่านั้น]
ขั้น 1: ค้นหาคำตอบจาก [ข้อมูลกฎหมายที่เกี่ยวข้องจากฐานข้อมูล] เป็นอันดับแรกเสมอ
ขั้น 2: ถ้าพบข้อมูลใน Blob → ตอบจาก Blob เท่านั้น ห้ามเพิ่มเติมจากแหล่งอื่น
ขั้น 3: ถ้าไม่พบใน Blob แต่มีใน [ความรู้สำคัญที่ต้องจำ] ด้านบน → ใช้เป็น fallback ได้ แต่ต้องระบุว่า "(จากฐานความรู้ระบบ)"
ขั้น 4: ถ้าไม่มีทั้งใน Blob และ fallback → ตอบว่า "ไม่พบข้อมูลในฐานข้อมูล กรุณาตรวจสอบเพิ่มเติมที่ www.cpd.go.th (กรมส่งเสริมสหกรณ์)" ห้ามคาดเดาหรือแต่งเติมเด็ดขาด
อ้างอิงแหล่งที่มาทุกข้อ เช่น (มาตรา 41 พ.ร.บ.สหกรณ์ 2542) หรือ (ข้อ 4 ระเบียบนายทะเบียนสหกรณ์) โดยระบุชื่อไฟล์จาก Blob ด้วยถ้าทราบ

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
