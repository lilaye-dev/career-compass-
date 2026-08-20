import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Groq from "groq-sdk";
import { Resend } from "resend";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const SHEET_URL = "https://script.google.com/macros/s/AKfycbx1IjkbMA049q1jJLy8su71dhr0VghGgwohsSBmoKMrpPz6fkwWiuoIGHsCe1mCdxbc/exec";

// ── Helpers ──────────────────────────────────────────────────
function extractJson(text) {
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// ── Career Paths ─────────────────────────────────────────────
function buildPathsPrompt({ year, branch, goal, skills }) {
  return `You are a career mentor for engineering students in India.

Student profile:
- Year: ${year}
- Branch: ${branch}
- Stated goal/direction: ${goal}
- Current skills and interests: ${skills}

Based on this, suggest 3 to 4 distinct, realistic career paths this student could pursue.
For each path give a short label, a brief but useful description (3-4 sentences: what it involves, why it fits them, rough difficulty/timeline to break in), ONE real learning resource (title + real URL), and if a good YouTube overview exists, ONE real video URL too (optional, omit field if none).

Respond with ONLY valid JSON, nothing else - no markdown, no explanation:

{
  "paths": [
    {
      "id": "string-slug",
      "title": "string",
      "description": "string",
      "resource": { "title": "string", "url": "string" },
      "video": { "title": "string", "url": "string" }
    }
  ]
}

Rules:
- 3 to 4 paths, no more, no less.
- "id" must be a short lowercase-hyphenated slug (e.g. "web-development").
- "video" field is optional - omit it entirely from the object if you don't have a real, well-known URL.
- Output raw JSON only.`;
}

app.post("/generate-paths", async (req, res) => {
  const { year, branch, goal, skills } = req.body || {};

  if (!year || !branch || !goal || !skills) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const prompt = buildPathsPrompt({ year, branch, goal, skills });
    const completion = await groq.chat.completions.create({
      model: "qwen/qwen3.6-27b",
      max_tokens: 2048,
      reasoning_effort: "none",
      messages: [{ role: "user", content: prompt }],
    });

    const text = completion.choices[0]?.message?.content;
    if (!text) throw new Error("No response from Groq");

    const parsed = extractJson(text);
    if (!parsed?.paths || !Array.isArray(parsed.paths) || parsed.paths.length < 3) {
      throw new Error("Invalid paths response");
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("generate-paths error:", err);
    return res.status(500).json({ error: "Failed to generate career paths" });
  }
});

// ── Roadmap (now supports a chosen path + custom day count) ──
function buildPrompt({ year, branch, goal, skills, pathTitle, days }) {
  const durationWeeks = Math.max(1, Math.round((days || 84) / 7));
  const focusLine = pathTitle
    ? `The student has chosen to pursue: "${pathTitle}". Tailor the entire roadmap specifically to this path.`
    : `Design a well-rounded general roadmap toward their stated goal.`;

  return `You are a career mentor for engineering students in India, designing a personalized roadmap.

Student profile:
- Year: ${year}
- Branch: ${branch}
- Goal: ${goal}
- Current skills: ${skills}

${focusLine}

Design a roadmap spanning exactly ${durationWeeks} week(s) (${days || 84} days total), calibrated to this exact profile.
- Start with fundamentals if beginner, skip basics if already skilled.
- Each week must have 2-3 concrete actionable tasks.
- Each week must include ONE real, well-known learning resource with a real URL.

Respond with ONLY valid JSON in exactly this shape, nothing else - no markdown, no explanation, no thinking, no preamble:

{
  "roadmap": [
    {
      "week": 1,
      "theme": "string",
      "tasks": ["string", "string", "string"],
      "resource": { "title": "string", "url": "string" },
      "status": "not_started"
    }
  ]
}

Rules:
- The roadmap array must contain exactly ${durationWeeks} objects, week 1 through ${durationWeeks} in order.
- tasks must be an array of 2 or 3 strings.
- status must always be the string "not_started".
- Output raw JSON only. No markdown code fences. No thinking. No explanation before or after.`;
}

function validateRoadmap(parsed, expectedWeeks) {
  if (!parsed || !Array.isArray(parsed.roadmap)) return "Missing roadmap array";
  if (parsed.roadmap.length !== expectedWeeks) return `Expected ${expectedWeeks} weeks, got ${parsed.roadmap.length}`;
  for (let i = 0; i < parsed.roadmap.length; i++) {
    const w = parsed.roadmap[i];
    if (typeof w.week !== "number" || w.week !== i + 1) return `Invalid week number at index ${i}`;
    if (!w.theme) return `Week ${i + 1} missing theme`;
    if (!Array.isArray(w.tasks) || w.tasks.length < 2) return `Week ${i + 1} needs 2-3 tasks`;
    if (!w.resource?.title || !w.resource?.url) return `Week ${i + 1} missing resource`;
    w.status = "not_started";
  }
  return null;
}

async function callGroqForRoadmap(profile, expectedWeeks, retryHint = null) {
  const prompt = buildPrompt(profile);
  const completion = await groq.chat.completions.create({
    model: "qwen/qwen3.6-27b",
    max_tokens: 4096,
    reasoning_effort: "none",
    messages: [
      {
        role: "user",
        content: retryHint
          ? `${prompt}\n\nIMPORTANT: Previous response was invalid because: ${retryHint}. Return ONLY the corrected raw JSON.`
          : prompt,
      },
    ],
  });
  const text = completion.choices[0]?.message?.content;
  if (!text) throw new Error("No response from Groq");
  return extractJson(text);
}

app.post("/generate-roadmap", async (req, res) => {
  const { year, branch, goal, skills, pathTitle, days } = req.body || {};

  if (!year || !branch || !goal || !skills) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: "GROQ_API_KEY is not set in .env" });
  }

  const profile = { year, branch, goal, skills, pathTitle, days: days || 84 };
  const expectedWeeks = Math.max(1, Math.round((days || 84) / 7));

  try {
    let parsed, error;

    try {
      parsed = await callGroqForRoadmap(profile, expectedWeeks);
      error = validateRoadmap(parsed, expectedWeeks);
    } catch (e) {
      error = e.message;
    }

    if (error) {
      console.warn("First attempt failed, retrying:", error);
      try {
        parsed = await callGroqForRoadmap(profile, expectedWeeks, error);
        error = validateRoadmap(parsed, expectedWeeks);
      } catch (e) {
        error = e.message;
      }
    }

    if (error) {
      return res.status(502).json({ error: "Failed to generate valid roadmap", details: error });
    }

    return res.status(200).json(parsed);
  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Unexpected server error" });
  }
});

// ── Save to Google Sheets + Send Email ───────────────────────
app.post("/subscribe", async (req, res) => {
  const { email, year, branch, goal, skills, roadmap } = req.body || {};

  if (!email || !roadmap) {
    return res.status(400).json({ error: "Email and roadmap are required" });
  }

  try {
    await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, year, branch, goal, skills }),
    });
  } catch (err) {
    console.error("Google Sheets error:", err);
  }

  try {
    const week1 = roadmap[0];
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #0f0c29; color: white; padding: 40px; border-radius: 12px;">
        <h1 style="color: #818cf8;">Career Compass 🧭</h1>
        <p style="color: #c4b5fd;">Your roadmap is ready!</p>
        <hr style="border-color: #374151; margin: 24px 0;" />
        <h2 style="color: white;">Your Goal: ${goal}</h2>
        <p style="color: #9ca3af;">Branch: ${branch} | Year: ${year}</p>
        <hr style="border-color: #374151; margin: 24px 0;" />
        <h3 style="color: #818cf8;">Week 1: ${week1.theme}</h3>
        <ul style="color: #d1d5db;">
          ${week1.tasks.map(t => `<li style="margin-bottom: 8px;">${t}</li>`).join("")}
        </ul>
        <p style="color: #9ca3af;">Resource: <a href="${week1.resource.url}" style="color: #818cf8;">${week1.resource.title}</a></p>
        <hr style="border-color: #374151; margin: 24px 0;" />
        <p style="color: #6b7280; font-size: 14px;">You will receive weekly reminders every Monday with your next week's tasks.</p>
        <p style="color: #6b7280; font-size: 14px;">Keep going — your career starts now! 🚀</p>
      </div>
    `;

    await resend.emails.send({
      from: "Career Compass <onboarding@resend.dev>",
      to: email,
      subject: "Your Career Roadmap is Ready! 🧭",
      html: emailHtml,
    });
  } catch (err) {
    console.error("Resend email error:", err);
    return res.status(500).json({ error: "Failed to send email" });
  }

  return res.status(200).json({ success: true, message: "Roadmap saved and email sent!" });
});

// ── Health ────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Career Compass backend running on http://localhost:${PORT}`);
});