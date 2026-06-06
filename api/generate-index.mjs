// api/generate-index.mjs
// เรียกครั้งเดียว → สร้าง index.json ใน Blob อัตโนมัติ
// GET https://your-app.vercel.app/api/generate-index

export default async function handler(req, res) {
  try {
    const baseUrl = 'https://a9t9gmv95hxqlfou.public.blob.vercel-storage.com';
    const token = process.env.BLOB_READ_WRITE_TOKEN;

    // ลอง list ด้วยทุก option ที่เป็นไปได้
    const { list, put } = await import('@vercel/blob');
    let blobs = [];
    let method = '';

    // ลอง 1: token อย่างเดียว
    try {
      const r = await list({ limit: 1000, token });
      if (r.blobs.length > 0) { blobs = r.blobs; method = 'token only'; }
    } catch(e) {}

    // ลอง 2: storeId อย่างเดียว
    if (!blobs.length) {
      try {
        const storeId = process.env.knowledge_public_STORE_ID;
        const r = await list({ limit: 1000, storeId });
        if (r.blobs.length > 0) { blobs = r.blobs; method = 'storeId only'; }
      } catch(e) {}
    }

    // ลอง 3: token + storeId
    if (!blobs.length) {
      try {
        const storeId = process.env.knowledge_public_STORE_ID;
        const r = await list({ limit: 1000, token, storeId });
        if (r.blobs.length > 0) { blobs = r.blobs; method = 'token+storeId'; }
      } catch(e) {}
    }

    // ลอง 4: ไม่มีอะไรเลย (OIDC)
    if (!blobs.length) {
      try {
        const r = await list({ limit: 1000 });
        if (r.blobs.length > 0) { blobs = r.blobs; method = 'OIDC'; }
      } catch(e) {}
    }

    if (!blobs.length) {
      return res.status(200).json({
        ok: false,
        error: 'list() ไม่ได้ไฟล์เลย — ลอง 4 วิธีแล้ว',
        env: {
          token: token ? token.slice(0,20)+'...' : 'NOT SET',
          storeId: process.env.knowledge_public_STORE_ID || 'NOT SET',
        }
      });
    }

    // สร้าง index.json
    const pathnames = blobs
      .filter(b => b.pathname.endsWith('.txt'))
      .map(b => b.pathname);

    // อัปโหลด index.json ไปที่ Blob
    const indexJson = JSON.stringify(pathnames, null, 2);
    await put('index.json', indexJson, {
      access: 'public',
      token,
      storeId: process.env.knowledge_public_STORE_ID,
      contentType: 'application/json',
      addRandomSuffix: false,
    });

    return res.status(200).json({
      ok: true,
      method,
      total: blobs.length,
      txt: pathnames.length,
      files: pathnames,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
