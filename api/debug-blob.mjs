// api/debug-blob.mjs — ทดสอบการเชื่อมต่อ Vercel Blob
// เรียกใช้: GET https://your-app.vercel.app/api/debug-blob

export default async function handler(req, res) {
  const results = {};

  // 1. ตรวจ env vars
  results.env = {
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN ? 
      process.env.BLOB_READ_WRITE_TOKEN.slice(0, 20) + '...' : 'NOT SET',
    BLOB_STORE_ID: process.env.BLOB_STORE_ID || 'NOT SET',
  };

  // 2. ลอง list ด้วย token
  try {
    const { list } = await import('@vercel/blob');
    const token = process.env.BLOB_READ_WRITE_TOKEN;

    // ลอง 1: ใช้ token
    if (token) {
      try {
        const r1 = await list({ limit: 10, token });
        results.list_with_token = { ok: true, count: r1.blobs.length, files: r1.blobs.map(b => b.pathname) };
      } catch(e) {
        results.list_with_token = { ok: false, error: e.message };
      }
    }

    // ลอง 2: ไม่ใช้ token (OIDC)
    try {
      const r2 = await list({ limit: 10 });
      results.list_oidc = { ok: true, count: r2.blobs.length, files: r2.blobs.map(b => b.pathname) };
    } catch(e) {
      results.list_oidc = { ok: false, error: e.message };
    }

  } catch(e) {
    results.import_error = e.message;
  }

  return res.status(200).json(results);
}
