const multer = require('multer');
const sharp = require('sharp');
const { httpError } = require('../lib/httpError');
const MAX_BYTES = 5 * 1024 * 1024;
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
const parseImage = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
    fields: 0,
    parts: 1,
    fieldNameSize: 40,
    headerPairs: 30,
    fieldNestingDepth: 0,
    fieldArrayIndexLimit: 0,
  },
  fileFilter: (req, file, done) =>
    done(
      allowed.has(file.mimetype) ? null : httpError(400, 'Invalid image'),
      allowed.has(file.mimetype)
    ),
}).single('image');
function imageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return 'image/png';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
async function reencodeImage(file) {
  if (!file || file.buffer.length > MAX_BYTES || imageType(file.buffer) !== file.mimetype) {
    throw httpError(400, 'Invalid image');
  }
  try {
    const image = sharp(file.buffer, {
      limitInputPixels: 20_000_000,
      failOn: 'warning',
      sequentialRead: true,
    }).timeout({ seconds: 5 });
    const metadata = await image.metadata();
    if ((metadata.pages || 1) !== 1 || !['jpeg', 'png', 'webp'].includes(metadata.format)) {
      throw new Error('Unsupported format');
    }
    const { data, info } = await image
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    // No keepMetadata/withMetadata: EXIF, GPS, XMP and original filenames are deliberately discarded.
    return { data, width: info.width, height: info.height, size: info.size };
  } catch {
    throw httpError(400, 'Invalid image');
  }
}
module.exports = { parseImage, reencodeImage, MAX_BYTES };
