/**
 * api/generate.js  – Vercel Serverless Function
 * Turns an uploaded image into a colouring-book outline (original / anime / ghibli).
 * Optimisations:
 *   • multiparty streaming upload (no body-parser RAM hit)
 *   • sharp down-scale to 512 px (or 384 px if >2 MB) + WebP@60/55 quality
 *   • OpenAI size:"auto"  → cost billed on upload pixels, not 1024²
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
    bodyParser: false,  // multiparty handles streaming
    sizeLimit : '8mb'   // plenty for ≤8 MB uploads
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ error: 'Method not allowed' });

  /* ── 1 · parse multipart upload ─────────────────────────── */
  let fields, files;
  try {
    ({ fields, files } = await new Promise((resolve, reject) => {
      new multiparty.Form().parse(req, (err, flds, fls) =>
        err ? reject(err) : resolve({ fields: flds, files: fls })
      );
    }));
  } catch {
    return res.status(400).json({ error: 'Invalid multipart form' });
  }

  const file0 = files?.image?.[0];
  if (!file0) return res.status(400).json({ error: 'No image uploaded' });

  const style  = (fields?.style?.[0] || 'original').toLowerCase();
  const prompt = PROMPTS[style] || PROMPTS.original;

  const origPath = file0.path;
  const mimeType = mime.lookup(file0.originalFilename || 'file.jpg');
  if (!mimeType) return res.status(400).json({ error: 'Unknown file type' });

  /* ── 2 · smart resize + WebP compress ───────────────────── */
  const targetWidth = file0.size > 2_000_000 ? 384 : 512;  // large file → smaller width
  const targetQ     = file0.size > 2_000_000 ? 55  : 60;   // adjust quality too

  const resizedBuf  = await sharp(origPath)
    .resize({ width: targetWidth })
    .webp({ quality: targetQ })
    .toBuffer();

  const resizedPath = origPath + '.webp';
  await fs.writeFile(resizedPath, resizedBuf);

  /* ── 3 · call OpenAI (size:auto for cheap billing) ──────── */
  try {
    const aiRes = await openai.images.edit({
      model : 'gpt-image-1',
      image : await fileFromPath(resizedPath, { type: 'image/webp' }),
      prompt,
      n     : 1,
      size  : 'auto'
    });

    const b64 = aiRes.data[0]?.b64_json;
    if (!b64) throw new Error('No image returned by OpenAI');

    res.status(200).json({ imageBase64: b64 });
  } catch (err) {
    console.error('OpenAI/processing error:', err);
    res.status(500).json({ error: err.message || 'Failed to process image' });
  } finally {
    /* ── 4 · clean temp files ─────────────────────────────── */
    await Promise.all([origPath, resizedPath].map(p => fs.unlink(p).catch(() => {})));
  }
}