const responseStatus = require("../../handlers/responseStatus.handler");
const { removeUploadedFile } = require("../../utils/uploadFactory");
const { callGemini } = require("../../utils/geminiClient");
const fs = require("fs");

exports.extractMarksFromImageService = async (filePath, mimeType, res) => {
  // H5: the temp file handed over by multer belongs to this function's scope,
  // so its removal is in a `finally` — the read, the Gemini call and the JSON
  // parse all have failure paths that used to strand the file on disk.
  try {
    return await extractMarkRowsFromImage(filePath, mimeType, res);
  } finally {
    removeUploadedFile(filePath);
  }
};

const extractMarkRowsFromImage = async (filePath, mimeType, res) => {
  const imageData = fs.readFileSync(filePath, { encoding: "base64" });

  const prompt = `You are reading a school exam marks sheet. It has printed/typed student names and handwritten scores next to each name. Rows may also carry a roll number / serial number column. Extract every row as JSON.

Return ONLY a JSON array, no other text, no markdown code fences. Each item must have exactly these fields:
- "name": the student's name exactly as printed (string)
- "rollNo": the row's roll/serial number as printed, as a string (use null if the sheet has no roll column)
- "score": the handwritten score as a number (no units, no "/100")

If a handwritten score is genuinely illegible or the space is left blank, set "score" to null (the pupil is treated as Absent).

Example output:
[{"name": "John Smith", "rollNo": "12", "score": 78}, {"name": "Jane Doe", "rollNo": null, "score": null}]`;

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
    // All keys exhausted / cooling down — the wrapper's specific message must
    // reach the review screen, never an empty result or a generic 500.
    if (err && err.geminiKeysExhausted) {
      return responseStatus(res, 503, "failed", err.message);
    }
    throw err;
  }

  const cleaned = response.text.replace(/```json\s*|```\s*/g, "").trim();

  let rows;
  try {
    rows = JSON.parse(cleaned);
  } catch (err) {
    return responseStatus(res, 500, "failed", "Could not parse OCR response as JSON. Raw output: " + response.text.slice(0, 500));
  }

  return responseStatus(res, 200, "success", rows);
};
