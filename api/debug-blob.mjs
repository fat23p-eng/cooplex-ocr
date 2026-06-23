// api/debug-blob.mjs — หา token ที่ใช้ได้จริง ครั้งเดียวจบ
// เรียก: GET https://your-app.vercel.app/api/debug-blob

export default async function handler(req, res) {
  const out = { envVarsFound: [], tests: [] };

  // ── 1. หา env var ทั้งหมดที่เกี่ยวกับ blob/knowledge ──
  out.envVarsFound = Object.keys(process.env)
    .filter(k => k.toLowerCase().includes('blob') || k.toLowerCase().includes('knowledge'))
    .map(k => ({ name: k, preview: (process.env[k] || '').slice(0, 15) + '...' }));

  // ── 2. ลองทุกวิธี list() ที่เป็นไปได้ ──
  try {
    const { list } = await import('@vercel/blob');

    const candidates = [
      { label: 'BLOB_READ_WRITE_TOKEN',            token: process.env.BLOB_READ_WRITE_TOKEN },
      { label: 'knowledge_public_READ_WRITE_TOKEN', token: process.env.knowledge_public_READ_WRITE_TOKEN },
    ];

    for (const c of candidates) {
      if (!c.token) { out.tests.push({ method: c.label, ok: false, error: 'env var not set' }); continue; }
      try {
        const r = await list({ token: c.token, limit: 50 });
        out.tests.push({
          method: c.label, ok: true,
          fileCount: r.blobs.length,
          files: r.blobs.map(b => b.pathname),
        });
      } catch (e) {
        out.tests.push({ method: c.label, ok: false, error: e.message });
      }
    }

    // OIDC (ไม่ใส่ token เลย — ใช้ได้ถ้า project ผูก Blob แบบ auto)
    try {
      const r = await list({ limit: 50 });
      out.tests.push({
        method: 'no-token (OIDC)', ok: true,
        fileCount: r.blobs.length,
        files: r.blobs.map(b => b.pathname),
      });
    } catch (e) {
      out.tests.push({ method: 'no-token (OIDC)', ok: false, error: e.message });
    }

  } catch (e) {
    out.importError = e.message;
  }

  // ── 3. สรุปให้ชัดว่าควรใช้อันไหน ──
  const working = out.tests.find(t => t.ok && t.fileCount > 0);
  out.RECOMMENDATION = working
    ? `✅ ใช้วิธีนี้: "${working.method}" — เจอ ${working.fileCount} ไฟล์`
    : '❌ ไม่มีวิธีไหนใช้ได้เลย — ตรวจสอบว่า Blob Store ผูกกับ Project แล้วหรือยัง (Storage → Connected Projects)';

  return res.status(200).json(out);
}
