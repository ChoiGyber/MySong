// AI settings + related-song recommendations via GPT/Gemini.
// API keys live in the OS credential store (DPAPI-protected on Windows);
// only non-secret preferences go to localStorage.
import { invoke } from "@tauri-apps/api/core";

export type Provider = "auto" | "gpt" | "gemini";

export interface AiSettings {
  gptKey: string;
  geminiKey: string;
  provider: Provider;
  relatedCount: number;
}

const SETTINGS_KEY = "mysong.settings.v1";
const GPT_SECRET = "gpt_api_key";
const GEMINI_SECRET = "gemini_api_key";

const secretSet = (name: string, value: string) =>
  invoke<void>("secret_set", { name, value });
const secretGet = (name: string) =>
  invoke<string>("secret_get", { name }).catch(() => "");

export async function loadSettings(): Promise<AiSettings> {
  const def: AiSettings = { gptKey: "", geminiKey: "", provider: "auto", relatedCount: 0 };
  let base = def;
  try {
    base = { ...def, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    /* ignore */
  }
  let [gptKey, geminiKey] = await Promise.all([secretGet(GPT_SECRET), secretGet(GEMINI_SECRET)]);
  // One-time migration: move plaintext keys saved by older builds into the
  // credential store, then scrub them from localStorage.
  if (base.gptKey || base.geminiKey) {
    if (base.gptKey && !gptKey) {
      await secretSet(GPT_SECRET, base.gptKey).catch(() => {});
      gptKey = base.gptKey;
    }
    if (base.geminiKey && !geminiKey) {
      await secretSet(GEMINI_SECRET, base.geminiKey).catch(() => {});
      geminiKey = base.geminiKey;
    }
    persistPrefs(base.provider, base.relatedCount);
  }
  return { gptKey, geminiKey, provider: base.provider, relatedCount: base.relatedCount };
}

function persistPrefs(provider: Provider, relatedCount: number) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ provider, relatedCount }));
  } catch {
    /* ignore */
  }
}

export async function saveSettings(s: AiSettings): Promise<void> {
  persistPrefs(s.provider, s.relatedCount);
  await secretSet(GPT_SECRET, s.gptKey);
  await secretSet(GEMINI_SECRET, s.geminiKey);
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
