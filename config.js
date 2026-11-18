export const USER_PREFERENCES = {
  targetRoles: [
    "Software Engineer",
    "Full Stack Developer",
    "Backend Developer",
    "Frontend Developer",
    "AI Engineer / GenAI / LLM Developer",
    "Python / Node.js / React Developer"
  ],
  maxExperienceYears: 2, // יסנן החוצה משרות שדורשות מעל 2 שנות ניסיון חובה
  excludedKeywords: [
    "qa manual",
    "helpdesk",
    "system administrator",
    "tier 1",
    "tier 2",
    "sales",
    "marketing",
    "hr ",
    "product manager"
  ],
  // מילות מפתח שחייבות להופיע (לפחות אחת) כדי שהודעת טקסט תישלח ל-Gemini
  preFilterKeywords: [
    "משרה", "מגייסים", "מגייסת", "דרוש", "דרושים", "פיתוח", "מפתח", "בוגר",
    "ג'וניור", "גוניור", "קורות חיים", "קו\"ח", "קוח", "hiring", "developer",
    "engineer", "fullstack", "full-stack", "full stack", "backend", "frontend",
    "react", "node", "python", "ai", "junior", "grad", "cv", "resume", "@"
  ]
};
