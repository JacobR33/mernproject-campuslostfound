async function assertTransactionsSupported(connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new Error('MongoDB replica set required');
  }
}
module.exports = { assertTransactionsSupported };
