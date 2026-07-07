// AI settings (localStorage) + related-song recommendations via GPT/Gemini.

export type Provider = "auto" | "gpt" | "gemini";

export interface AiSettings {
  gptKey: string;
  geminiKey: string;
  provider: Provider;
  relatedCount: number;
}

const SETTINGS_KEY = "mysong.settings.v1";

export function loadSettings(): AiSettings {
  const def: AiSettings = { gptKey: "", geminiKey: "", provider: "auto", relatedCount: 0 };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return def;
    return { ...def, ...JSON.parse(raw) };
  } catch {
    return def;
  }
}

export function saveSettings(s: AiSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Which provider a request will actually use, or null if no key is usable. */
export function activeProvider(s: AiSettings): "gpt" | "gemini" | null {
  if (s.provider === "gpt") return s.gptKey ? "gpt" : null;
  if (s.provider === "gemini") return s.geminiKey ? "gemini" : null;
  if (s.geminiKey) return "gemini";
  if (s.gptKey) return "gpt";
  return null;
}

/** Ask the configured AI for `count` songs similar to `title`. Returns "Artist - Title" strings. */
export async function relatedSongs(title: string, count: number, s: AiSettings): Promise<string[]> {
  const provider = activeProvider(s);
  if (!provider) throw "설정에서 API 키를 먼저 입력하세요";
  const prompt =
    `"${title}" 곡과 비슷한 분위기/장르의 음악 ${count}곡을 추천해줘. ` +
    `원곡 자체는 제외하고, 실제로 존재하는 곡만. ` +
    `응답은 JSON 문자열 배열로만 답해. 각 항목은 "아티스트 - 곡제목" 형식. 다른 텍스트 금지.`;
  const text = provider === "gemini" ? await askGemini(prompt, s.geminiKey) : await askGpt(prompt, s.gptKey);
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw "AI 응답을 해석하지 못했습니다";
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw "AI 응답을 해석하지 못했습니다";
  return arr.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

async function askGpt(prompt: string, key: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.8,
    }),
  });
  if (!res.ok) throw `GPT 요청 실패 (${res.status}): API 키를 확인하세요`;
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? "";
}

async function askGemini(prompt: string, key: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  if (!res.ok) throw `Gemini 요청 실패 (${res.status}): API 키를 확인하세요`;
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
