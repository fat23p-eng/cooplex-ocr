# CoopLex OCR — Deploy บน Vercel

## โครงสร้างไฟล์
```
cooplex-ocr/
├── api/
│   └── ocr.js       ← Backend ซ่อน API Key
├── index.html       ← หน้าแอป
├── vercel.json      ← Config
└── README.md
```

---

## ขั้นตอน Deploy (~10 นาที)

### 1. สมัคร GitHub (ถ้ายังไม่มี)
- เปิด github.com → Sign Up

### 2. สร้าง Repository ใหม่
- กด + → New Repository
- ชื่อ: cooplex-ocr
- กด Create Repository

### 3. อัปโหลดไฟล์
- กด "uploading an existing file"
- ลากไฟล์ทั้งหมดขึ้นไป (รวมโฟลเดอร์ api/)
- กด Commit changes

### 4. สมัคร Vercel
- เปิด vercel.com → Sign Up with GitHub

### 5. Import Project
- กด Add New → Project
- เลือก Repository: cooplex-ocr
- กด Import

### 6. ใส่ API Key (สำคัญมาก!)
- ก่อนกด Deploy → กด "Environment Variables"
- Name:  CLAUDE_API_KEY
- Value: sk-ant-api03-xxxx (API Key ของคุณ)
- กด Add

### 7. Deploy!
- กด Deploy
- รอ ~1 นาที
- ได้ URL: https://cooplex-ocr-xxx.vercel.app

---

## ใช้งาน
1. เปิด URL ที่ได้จาก Vercel
2. ลาก PDF มาวาง
3. กด "เริ่มแปลง"
4. ดาวน์โหลด Word ได้เลย

---

## หมายเหตุ
- Claude API Key ซ่อนใน Vercel Environment Variable
- ผู้ใช้ไม่เห็น Key ปลอดภัย 100%
- Vercel ฟรี Hobby plan: 100GB bandwidth/เดือน
