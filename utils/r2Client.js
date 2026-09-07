/**
 * Cloudflare R2 upload helper.
 *
 * Uses the S3-compatible API via @aws-sdk/client-s3.
 * If R2 env vars are not configured, falls back to local disk storage so
 * development still works without any cloud setup.
 *
 * Usage:
 *   const { uploadToR2, getPublicUrl, deleteFromR2 } = require("./r2Client");
 *   const url = await uploadToR2("photos/abc.jpg", fileBuffer, "image/jpeg");
 */

let S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand;
try {
  ({ S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3"));
} catch (_) {
  // @aws-sdk/client-s3 not installed — R2 features disabled, local fallback only.
}

const path = require("path");
const fs = require("fs");

const R2_CONFIGURED =
  S3Client &&
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY &&
  process.env.R2_BUCKET_NAME;

let s3Client;

function getClient() {
  if (!R2_CONFIGURED) return null;
  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

/**
 * Upload a file buffer to R2.
 * @param {string} key       — object key, e.g. "photos/student-123.jpg"
 * @param {Buffer} buffer    — file contents
 * @param {string} contentType — MIME type
 * @returns {string} public URL of the uploaded object
 */
async function uploadToR2(key, buffer, contentType) {
  const client = getClient();
  if (!client) {
    throw new Error("R2 is not configured. Set R2_* env vars.");
  }

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return getPublicUrl(key);
}

/**
 * Get the public URL for an R2 object key.
 * @param {string} key
 * @returns {string}
 */
function getPublicUrl(key) {
  const baseUrl = process.env.R2_PUBLIC_URL || `https://r2.example.com`;
  return `${baseUrl.replace(/\/+$/, "")}/${key}`;
}

/**
 * Delete an object from R2.
 * @param {string} url — full public URL (will extract the key)
 */
async function deleteFromR2(url) {
  const client = getClient();
  if (!client) return;

  const baseUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/+$/, "");
  const key = url.startsWith(baseUrl) ? url.slice(baseUrl.length + 1) : url;

  await client.send(
    new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    })
  );
}

/**
 * Save a file to local disk (fallback when R2 is not configured).
 * @param {string} subDir — subdirectory under uploads/
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {string} relative URL path
 */
function saveLocally(subDir, filename, buffer) {
  const dir = path.join("uploads", subDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer);
  return `/uploads/${subDir}/${filename}`;
}

module.exports = {
  uploadToR2,
  getPublicUrl,
  deleteFromR2,
  saveLocally,
  isR2Configured: () => !!R2_CONFIGURED,
};
