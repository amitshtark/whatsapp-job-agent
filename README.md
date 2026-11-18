# WhatsApp Job Agent (Mac Local Edition)

סוכן מקומי שרץ על ה-Mac, מאזין לקבוצות וואטסאפ של משרות בזמן אמת, מסנן כפילויות מול `tech-job-tracker-Israel` ובין קבוצות שונות, ושולח התראות Live לטלגרם.

## הפעלה מהירה
1. ערוך את קובץ `.env` והכנס את `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN` ו-`TELEGRAM_CHAT_ID`.
2. הרץ בטרמינל:
   ```bash
   npm install
   npm start
   ```
3. סרוק את קוד ה-QR שמופיע בטרמינל באמצעות וואטסאפ.
4. העתק מהטרמינל את מזהי הקבוצות (`...@g.us`) הרלוונטיות והדבק אותן ב-`ALLOWED_GROUP_JIDS` בקובץ `.env`.
5. הפעל מחדש (`Ctrl+C` ואז `npm start`).
