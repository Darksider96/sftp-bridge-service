const Client = require('ssh2-sftp-client');

function getSftpConfig() {
  const host = process.env.SFTP_HOST;
  const username = process.env.SFTP_USER;
  const password = process.env.SFTP_PASS;
  const port = parseInt(process.env.SFTP_PORT || '22', 10);

  if (!host || !username || !password) {
    return null;
  }
  return { host, port, username, password };
}

async function withSftpConnection(fn) {
  const config = getSftpConfig();
  if (!config) {
    throw new Error('Secrets do SFTP ausentes no serviço (SFTP_HOST/SFTP_USER/SFTP_PASS)');
  }

  const sftp = new Client();
  try {
    await sftp.connect(config);
    return await fn(sftp);
  } finally {
    await sftp.end().catch(() => {});
  }
}

/** Lista o conteúdo (não-recursivo) de um diretório remoto. */
async function listDir(remoteDir) {
  return withSftpConnection((sftp) => sftp.list(remoteDir));
}

/** Baixa um arquivo remoto e retorna seu conteúdo como Buffer. */
async function download(remotePath) {
  return withSftpConnection((sftp) => sftp.get(remotePath));
}

/** Move um arquivo remoto para outro diretório, criando-o se necessário. */
async function moveTo(fromPath, toDir) {
  return withSftpConnection(async (sftp) => {
    await sftp.mkdir(toDir, true);
    const fileName = fromPath.split('/').pop();
    const toPath = `${toDir}/${fileName}`;
    await sftp.rename(fromPath, toPath);
    return toPath;
  });
}

module.exports = { getSftpConfig, withSftpConnection, listDir, download, moveTo };
