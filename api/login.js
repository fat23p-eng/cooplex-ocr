// api/login.js — ตรวจรหัสผ่านฝั่ง server + ออก signed token
// env vars ที่ต้องตั้ง:
//   ADMIN_PASS=รหัสadmin
//   OFFICER_PASS=รหัสofficer
//   TOKEN_SECRET=สตริงสุ่มยาวๆ เช่น openssl rand -hex 32

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { pass } = req.body;
  if (!pass) return res.status(400).json({ error: 'Missing pass' });

  const adminPass   = process.env.ADMIN_PASS;
  const officerPass = process.env.OFFICER_PASS;
  const secret      = process.env.TOKEN_SECRET;

  if (!secret) return res.status(500).json({ error: 'TOKEN_SECRET not set' });

  // ── ตรวจรหัส ─────────────────────────────────────
  let role = null;
  if (adminPass   && pass === adminPass)   role = 'admin';
  if (officerPass && pass === officerPass) role = 'officer';

  if (!role) {
    // delay 500ms กัน brute force
    await new Promise(r => setTimeout(r, 500));
    return res.status(200).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
  }

  // ── ออก token (HMAC-SHA256 แบบง่าย ไม่ต้องติดตั้ง library) ──
  const exp     = Date.now() + 1000 * 60 * 60 * 24 * 7; // 7 วัน
  const payload = `${role}:${exp}`;
  const sig     = await hmacSign(payload, secret);
  const token   = `${payload}:${sig}`;

  console.log('Login:', role, 'token issued');
  return res.status(200).json({ ok: true, role, token, exp });
}

// ── ตรวจ token (เรียกจาก API อื่น) ─────────────────
export async function verifyToken(token, secret) {
  if (!token || !secret) return null;
  try {
    const parts = token.split(':');
    if (parts.length !== 3) return null;
    const [role, exp, sig] = parts;
    if (Date.now() > parseInt(exp)) return null; // หมดอายุ
    const expected = await hmacSign(`${role}:${exp}`, secret);
    if (sig !== expected) return null; // ปลอม
    return role;
  } catch { return null; }
}

// ── HMAC-SHA256 ใช้ Web Crypto API (built-in Node 18+) ──
async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return Buffer.from(sig).toString('hex');
}
