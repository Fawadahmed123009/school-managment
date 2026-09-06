const { GoogleGenAI } = require("@google/genai");
const responseStatus = require("../../handlers/responseStatus.handler");
const fs = require("fs");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const RETRY_DELAYS_MS = [1000, 3000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callGemini = async (params) => {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastError = err;
      if (err.status === 503 && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};

exports.extractFeesFromImageService = async (filePath, mimeType, res) => {
  const imageData = fs.readFileSync(filePath, { encoding: "base64" });

  const prompt = `You are reading a school fee collection sheet. It has printed/typed student names and handwritten fee amounts next to each name. Extract every row as JSON.

Return ONLY a JSON array, no other text, no markdown code fences. Each item must have exactly these fields:
- "name": the student's name exactly as printed (string)
- "amount": the handwritten fee amount as a number (no currency symbols, no commas)

If a handwritten amount is genuinely illegible or missing, set "amount" to null instead of guessing.

Example output:
[{"name": "John Smith", "amount": 5000}, {"name": "Jane Doe", "amount": null}]`;

  let response;
  try {
    response = await callGemini({
      model: "gemini-3.6-flash",
      contents: [
        { text: prompt },
        { inlineData: { mimeType: mimeType, data: imageData } },
      ],
    });
  } catch (err) {
    fs.unlink(filePath, () => {});
    if (err.status === 503) {
      return responseStatus(res, 503, "failed", "OCR service is busy, please try again in a moment");
    }
    throw err;
  }

  const responseText = response.text;

  const cleaned = responseText.replace(/```json\s*|```\s*/g, "").trim();

  let rows;
  try {
    rows = JSON.parse(cleaned);
  } catch (err) {
    return responseStatus(res, 500, "failed", "Could not parse OCR response as JSON. Raw output: " + responseText.slice(0, 500));
  }

  fs.unlink(filePath, () => {});

  return responseStatus(res, 200, "success", rows);
};
