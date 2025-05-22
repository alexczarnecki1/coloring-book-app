/**
 * api/generate.js
 * Vercel Serverless Function – turns an uploaded image into a colouring-book outline.
 * Handles three styles: original, anime, ghibli.
 * Expects multipart/form-data with fields:
 *   • image  – the file
 *   • style  – "original" | "anime" | "ghibli"
 */

import { promises as fs } from 'fs';
import sharp              from 'sharp';
import mime               from 'mime-types';
import multiparty         from 'multiparty';
import { fileFromPath }   from 'formdata-node/file-from-path';
import { OpenAI }         from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PROMPTS = {
  original:
    'Convert this image into a clean black-and-white colouring-book outline, preserving the original style.',
  anime:
    'Convert this image into ANIME-style black-and-white line art suitable for a colouring book. Keep outlines bold and expressive.',
  ghibli:
    'Convert this image into a STUDIO GHIBLI-inspired black-and-white colouring-book outline with gentle, whimsical lines.'
};

export const config = {
  api: {
    bodyParser: false,   // multiparty handles the upload
    sizeLimit: '8mb'     // plenty for 768-px WebP
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  /* ── 1 · parse multipart form ───────────────────────────── */
  let fields, files;
  try {
    ({ fields, files } = await new Promise((resolve, reject) => {
      new multiparty.Form().parse(req, (err, flds, fls) =>
        err ? reject(err) : resolve({ fields: flds, files: fls })
      );
    }));
  } catch (err) {
    return res.status(400).json({ error: 'Invalid multipart form' });
  }

  const file0 = files?.image?.[0];
  if (!file0) return res.status(400).json({ error: 'No image uploaded' });

  const style  = (fields?.style?.[0] || 'original').toLowerCase();
  const prompt = PROMPTS[style] || PROMPTS.original;

  const origPath = file0.path;
  const mimeType = mime.lookup(file0.originalFilename || 'file.jpg');

/* ---------- smart resize & compress ---------- */
const targetWidth  = file0.size > 2_000_000 ? 384 : 512;   // >2 MB → 384 px, else 512 px
const targetQ      = file0.size > 2_000_000 ? 55  : 60;    // slightly lower quality for big files

const resizedBuf = await sharp(origPath)
  .resize({ width: targetWidth })
  .webp({ quality: targetQ })
  .toBuffer();

  const resizedPath = origPath + '.webp';
  await fs.writeFile(resizedPath, resizedBuf);

  try {
    /* ── 3 · OpenAI call (size:auto = billed by upload size) ─ */
    const aiRes = await openai.images.edit({
      model : 'gpt-image-1',
      image : await fileFromPath(resizedPath, { type: 'image/webp' }),
      prompt,
      n     : 1,
      size  : 'auto'
    });

    const b64 = aiRes.data[0]?.b64_json;
    if (!b64) throw new Error('No image returned by OpenAI');

    /* ── 4 · send base-64 PNG back to browser ─────────────── */
    res.status(200).json({ imageBase64: b64 });
  } catch (err) {
    console.error('OpenAI/processing error:', err);
    res.status(500).json({ error: err.message || 'Failed to process image' });
  } finally {
    /* ── 5 · clean temp files ─────────────────────────────── */
    await Promise.all([origPath, resizedPath].map(p => fs.unlink(p).catch(() => {})));
  }
}


