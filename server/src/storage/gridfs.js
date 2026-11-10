const mongoose = require('mongoose');
const { GridFSBucket } = mongoose.mongo;
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// No GridFS calls belong inside a MongoDB transaction. Upload ledger documents coordinate cleanup.
function createGridFSStorage(connection = mongoose.connection) {
  const bucket = () => new GridFSBucket(connection.db, { bucketName: 'images' });
  return {
    async write(id, data, filename) {
      const stream = bucket().openUploadStreamWithId(id, filename, { contentType: 'image/jpeg' });
      try {
        await pipeline(Readable.from(data), stream, { signal: AbortSignal.timeout(30000) });
      } catch (error) {
        await stream.abort().catch(() => {});
        throw error;
      }
    },
    async read(id) {
      const entry = await connection.db
        .collection('images.files')
        .findOne({ _id: id }, { projection: { _id: 1 } });
      return entry ? bucket().openDownloadStream(id) : null;
    },
    async remove(id) {
      // Explicit idempotent removal also handles partially written files without a files record.
      await connection.db.collection('images.chunks').deleteMany({ files_id: id });
      await connection.db.collection('images.files').deleteOne({ _id: id });
    },
    async sweepOrphans(cutoff, limit = 50) {
      const files = await connection.db
        .collection('images.files')
        .aggregate(
          [
            { $match: { uploadDate: { $lte: cutoff } } },
            { $lookup: { from: 'uploads', localField: '_id', foreignField: '_id', as: 'ledger' } },
            { $match: { ledger: { $size: 0 } } },
            { $limit: limit },
            { $project: { _id: 1 } },
          ],
          { maxTimeMS: 5000, allowDiskUse: false }
        )
        .toArray();
      for (const file of files) await this.remove(file._id);
      const remaining = limit - files.length;
      if (!remaining) {
        return files.length;
      }
      // Reconcile interrupted chunks even if both the ledger and files entry were lost.
      const chunks = await connection.db
        .collection('images.chunks')
        .aggregate(
          [
            {
              $match: {
                files_id: {
                  $lte: mongoose.Types.ObjectId.createFromTime(Math.floor(cutoff.getTime() / 1000)),
                },
              },
            },
            { $group: { _id: '$files_id' } },
            { $lookup: { from: 'uploads', localField: '_id', foreignField: '_id', as: 'ledger' } },
            {
              $lookup: { from: 'images.files', localField: '_id', foreignField: '_id', as: 'file' },
            },
            { $match: { ledger: { $size: 0 }, file: { $size: 0 } } },
            { $limit: remaining },
            { $project: { _id: 1 } },
          ],
          { maxTimeMS: 5000, allowDiskUse: false }
        )
        .toArray();
      for (const chunk of chunks) await this.remove(chunk._id);
      return files.length + chunks.length;
    },
  };
}
module.exports = { createGridFSStorage };
