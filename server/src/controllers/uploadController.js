const mongoose = require('mongoose');
const { pipeline } = require('node:stream/promises');
const { randomBytes } = require('node:crypto');
const Upload = require('../models/upload');
const { Post, Item, User } = require('../models');
const { parseImage, reencodeImage } = require('../middleware/imageUpload');
const { httpError } = require('../lib/httpError');
const { trusted } = mongoose;
const { z } = require('zod');
const { withTransaction } = require('../lib/transaction');
const { lockActor } = require('../lib/lockActor');
let activeUploads = 0;
function createUploadController(storage, logger) {
  return {
    async upload(req, res) {
      if (activeUploads >= 2) {
        res.set('Retry-After', '1');
        throw httpError(503, 'Uploads busy');
      }
      activeUploads++;
      let record;
      try {
        await new Promise((resolve, reject) =>
          parseImage(req, res, (error) => {
            if (!error) {
              return resolve();
            }
            if (error.name === 'MulterError' || error.httpStatus) {
              return reject(error);
            }
            reject(httpError(400, 'Invalid image request'));
          })
        );
        if (
          !z
            .object({})
            .strict()
            .safeParse(req.body || {}).success
        ) {
          throw httpError(400, 'Invalid request');
        }
        const image = await reencodeImage(req.file);
        await withTransaction(async (session) => {
          await lockActor(session, req.user, req.auth.version);
          [record] = await Upload.create(
            [
              {
                owner: req.user._id,
                filename: `${randomBytes(24).toString('hex')}.jpg`,
                state: 'writing',
                expiresAt: new Date(Date.now() + 60 * 60 * 1000),
              },
            ],
            { session }
          );
        });
        await storage.write(record._id, image.data, record.filename);
        const result = await Upload.updateOne(
          { _id: record._id, state: 'writing' },
          {
            $set: {
              state: 'staged',
              size: image.size,
              width: image.width,
              height: image.height,
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          }
        );
        if (result.modifiedCount !== 1) {
          throw httpError(409, 'Upload expired');
        }
        res.status(201).json({
          image: {
            id: String(record._id),
            url: `/api/uploads/${record._id}/preview`,
            contentType: 'image/jpeg',
            size: image.size,
            width: image.width,
            height: image.height,
          },
        });
      } catch (error) {
        if (record) {
          try {
            await Upload.updateOne({ _id: record._id }, { $set: { state: 'deleting' } });
            await storage.remove(record._id);
            await Upload.deleteOne({ _id: record._id, state: 'deleting' });
          } catch {
            logger('upload_cleanup_deferred', { code: 'storage' });
          }
        }
        throw error;
      } finally {
        activeUploads--;
      }
    },
    async serve(req, res, preview = false) {
      const filter = preview
        ? {
            _id: req.validated.params.id,
            owner: req.user._id,
            state: 'staged',
            expiresAt: trusted({ $gt: new Date() }),
          }
        : { _id: req.validated.params.id, state: 'attached' };
      const upload = await Upload.findOne(filter);
      if (!upload) {
        throw httpError(404, 'Not found');
      }
      if (!preview) {
        const post = await Post.findOne({
          _id: upload.post,
          deletedAt: null,
          expiresAt: trusted({ $gt: new Date() }),
        });
        const item = post && (await Item.exists({ _id: post.item, images: upload._id }));
        const author = post && (await User.exists({ _id: post.author, isBanned: false }));
        if (!post || !item || !author) {
          throw httpError(404, 'Not found');
        }
      }
      const stream = await storage.read(upload._id);
      if (!stream) {
        throw httpError(404, 'Not found');
      }
      res.set({
        'Content-Type': 'image/jpeg',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${upload.filename}"`,
        'Cross-Origin-Resource-Policy': 'same-site',
      });
      try {
        await pipeline(stream, res);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) {
          throw error;
        }
        logger('image_stream_failed', { code: 'storage' });
      }
    },
    async discard(req, res) {
      const upload = await Upload.findOneAndUpdate(
        { _id: req.validated.params.id, owner: req.user._id, state: 'staged' },
        { $set: { state: 'deleting' } },
        { new: true }
      );
      if (!upload) {
        throw httpError(404, 'Not found');
      }
      try {
        await storage.remove(upload._id);
        await Upload.deleteOne({ _id: upload._id, state: 'deleting' });
      } catch {
        logger('upload_cleanup_deferred', { code: 'storage' });
      }
      res.status(204).end();
    },
  };
}
module.exports = { createUploadController };
