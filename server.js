// server.js  – complete modern version with sharp resize
// ─────────────────────────────────────────────────
const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fs      = require('fs');
const sharp   = require('sharp');
const { OpenAI }       = require('openai');
const { fileFromPath } = require('formdata-node/file-from-path');
const mime    = require('mime-types');
require('dotenv').config();

const app  = express();
const PORT = 3000;

/* -- CORS: frontend served from http://localhost:8080 */
app.use(cors({ origin: 'http://localhost:8080', methods: ['POST'] }));
app.use(express.json());

/* save original upload to /tmp (outside project) */
const upload = multer({ dest: '/tmp/coloring-uploads' });

/* style → prompt map */
const PROMPTS = {
  original:
    'Convert this image into a clean black-and-white coloring-book outline, preserving the original style.',
  anime:
    'Convert this image into ANIME-style black-and-white coloring-book line art suitable for a coloring book.',
  ghibli:
    'Convert this image into a STUDIO GHIBLI-inspired black-and-white coloring-book outline with gentle, whimsical lines.'
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post('/generate-from-image', upload.single('image'), async (req, res) => {
  const t0 = Date.now();
  let originalPath, resizedPath;
  try {
    /* 1 - validate upload */
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    originalPath = req.file.path;
    const mimeType = mime.lookup(req.file.originalname);
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType))
      return res.status(400).json({ error: 'Unsupported file type.' });

    /* 2 - down-scale in memory */
    const resizedBuf = await sharp(originalPath)
      .resize({ width: 768 })
      .webp({ quality: 70 })
      .toBuffer();

    /* 3 - save resized buffer to tmp file for OpenAI helper */
    resizedPath = originalPath + '.webp';
    fs.writeFileSync(resizedPath, resizedBuf);

    /* 4 - pick prompt */
    const style  = (req.body?.style || 'original').toLowerCase();
    const prompt = PROMPTS[style] || PROMPTS.original;

    /* 5 - OpenAI call */
    const file = await fileFromPath(resizedPath, { type: 'image/webp' });
    const aiRes = await openai.images.edit({
      model : 'gpt-image-1',
      image : file,
      prompt,
      n     : 1,
      size  : 'auto'
    });

    const b64 = aiRes.data[0]?.b64_json;
    if (!b64) throw new Error('OpenAI returned no image.');
    res.json({ imageBase64: b64 });

    console.log(
      `✅ ${style} done in ${(Date.now() - t0) / 1000}s  (upload → resize → OpenAI)`
    );
  } catch (err) {
    console.error('❌ Server error:', err);
    res.status(500).json({ error: err.message || 'Failed to process image' });
  } finally {
    /* 6 - clean temp files */
    [originalPath, resizedPath].forEach(p => p && fs.existsSync(p) && fs.unlinkSync(p));
  }
});

const server = app.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
server.setTimeout(120_000); // 2 min request timeout

