const { GoogleGenAI } = require("@google/genai");
const responseStatus = require("../../handlers/responseStatus.handler");
const fs = require("fs");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

exports.extractFeesFromImageService = async (filePath, mimeType, res) => {
  const imageData = fs.readFileSync(filePath, { encoding: "base64" });

  const prompt = `You are reading a school fee collection sheet. It has printed/typed student names and handwritten fee amounts next to each name. Extract every row as JSON.

Return ONLY a JSON array, no other text, no markdown code fences. Each item must have exactly these fields:
- "name": the student's name exactly as printed (string)
- "amount": the handwritten fee amount as a number (no currency symbols, no commas)

If a handwritten amount is genuinely illegible or missing, set "amount" to null instead of guessing.

Example output:
[{"name": "John Smith", "amount": 5000}, {"name": "Jane Doe", "amount": null}]`;

  const response = await ai.models.generateContent({
    model: "gemini-3.6-flash",
    contents: [
      { text: prompt },
      { inlineData: { mimeType: mimeType, data: imageData } },
    ],
  });

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
