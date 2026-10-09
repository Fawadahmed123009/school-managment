const responseStatus = require("../../handlers/responseStatus.handler");
const { removeUploadedFile } = require("../../utils/uploadFactory");
const { callGemini } = require("../../utils/geminiClient");
const fs = require("fs");

exports.extractFeesFromImageService = async (filePath, mimeType, res) => {
  // H5: the temp file handed over by multer belongs to this function's scope,
  // so its removal is in a `finally` — the read, the Gemini call and the JSON
  // parse all have failure paths that used to strand the file on disk.
  try {
    return await extractFeeRowsFromImage(filePath, mimeType, res);
  } finally {
    removeUploadedFile(filePath);
  }
};

const extractFeeRowsFromImage = async (filePath, mimeType, res) => {
  const imageData = fs.readFileSync(filePath, { encoding: "base64" });

  const prompt = `You are reading a school fee collection sheet. It has printed/typed student names and handwritten fee amounts next to each name. Rows may also carry a roll number / serial number column. Extract every row as JSON.

Return ONLY a JSON array, no other text, no markdown code fences. Each item must have exactly these fields:
- "name": the student's name exactly as printed (string)
- "rollNo": the row's roll/serial number as printed, as a string (use null if the sheet has no roll column)
- "amount": the handwritten fee amount as a number (no currency symbols, no commas)

If a handwritten amount is genuinely illegible or missing, set "amount" to null instead of guessing.

Example output:
[{"name": "John Smith", "rollNo": "12", "amount": 5000}, {"name": "Jane Doe", "rollNo": null, "amount": null}]`;

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

  const responseText = response.text;

  const cleaned = responseText.replace(/```json\s*|```\s*/g, "").trim();

  let rows;
  try {
    rows = JSON.parse(cleaned);
  } catch (err) {
    return responseStatus(res, 500, "failed", "Could not parse OCR response as JSON. Raw output: " + responseText.slice(0, 500));
  }

  return responseStatus(res, 200, "success", rows);
};
