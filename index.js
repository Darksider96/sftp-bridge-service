const express = require('express');
const path = require('path');
const { withSftpConnection, getSftpConfig } = require('./sftpClient');

const app = express();

const PORT = process.env.PORT || 3000;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const SFTP_REMOTE_DIR = process.env.SFTP_REMOTE_DIR || '/flag-contato/Envio';

if (!BRIDGE_TOKEN) {
  console.error('BRIDGE_TOKEN não configurado. Defina essa variável de ambiente antes de iniciar o serviço.');
  process.exit(1);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/upload', express.raw({ type: '*/*', limit: '25mb' }), async (req, res) => {
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== BRIDGE_TOKEN) {
    return res.status(401).json({ success: false, error: 'Token inválido' });
  }

  const rawFileName = req.get('x-file-name');
  if (!rawFileName) {
    return res.status(400).json({ success: false, error: 'Header x-file-name é obrigatório' });
  }
  // Evita path traversal: usa só o nome final do arquivo, sem separadores de diretório
  const fileName = path.basename(rawFileName);

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ success: false, error: 'Corpo da requisição vazio' });
  }

  if (!getSftpConfig()) {
    return res.status(500).json({ success: false, error: 'Secrets do SFTP ausentes no serviço (SFTP_HOST/SFTP_USER/SFTP_PASS)' });
  }

  const remotePath = `${SFTP_REMOTE_DIR}/${fileName}`;

  try {
    await withSftpConnection((sftp) => sftp.put(req.body, remotePath));
    res.json({ success: true, remotePath });
  } catch (error) {
    console.error('Erro no upload SFTP:', error);
    res.status(502).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`sftp-bridge-service ouvindo na porta ${PORT}`);
});
