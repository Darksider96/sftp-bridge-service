// Regras fixas por cliente (layout_profile), aplicadas no arquivo final
// pós-PROCV em checkRetorno.js. Nenhuma delas depende do layout do arquivo —
// DDD/Telefone continuam 100% detectados por heurística em csvProcessor.js.
const { detectPhonePairs } = require('./mailingNormalizer');

// "Padrão Vanguard": o discador (Argus/Dazsoft) só reconhece/casa o cliente
// do lado deles se o CODIGO vier em minúsculo. Opt-in por cliente (campo
// is_vanguard do perfil) — sem o perfil marcado, a coluna não é alterada.
function applyVanguardPattern(rows, isVanguard) {
  if (!isVanguard || !rows.length) return rows;
  const codigoKey = Object.keys(rows[0]).find(
    (h) => h.toLowerCase().includes('codigo') || h.toLowerCase().includes('código')
  );
  if (!codigoKey) return rows;
  return rows.map((row) => ({ ...row, [codigoKey]: String(row[codigoKey] ?? '').toLowerCase() }));
}

// Regra FINAZ: substitui a coluna ID/CÓDIGO/FINAZ, na MESMA posição em que
// ela estava, por duas colunas (CodigoFinaz, ProspeccaoId) com o mesmo valor.
// Importante manter a ordem das colunas igual à do arquivo original — o
// discador do cliente pode ler o arquivo por posição, não só por nome de
// coluna (bug real encontrado em produção: mover pro início quebrava isso).
// Configurável por layout_profile (campo is_finaz).
function applyFinazRule(rows) {
  if (!rows.length) return rows;
  const headers = Object.keys(rows[0]);
  const idColumn = headers.find((h) => /id|codigo|código|finaz/i.test(h)) || headers[0];
  return rows.map((row) => {
    const idValue = row[idColumn] ?? '';
    const result = {};
    for (const key of Object.keys(row)) {
      if (key === idColumn) {
        result.CodigoFinaz = idValue;
        result.ProspeccaoId = idValue;
      } else {
        result[key] = row[key];
      }
    }
    return result;
  });
}

// RF-003: só o primeiro telefone detectado (o mais à esquerda) é enviado à
// higienização e decide a aprovação da linha — os demais telefones que o
// cliente mandar no arquivo original são "excedentes". Aqui decide o que
// fazer com eles no arquivo final: excluir a coluna ou mantê-la vazia.
// Configurável por layout_profile (campo phone_overflow_action).
function applyPhoneOverflowRule(rows, action) {
  if (!rows.length) return rows;
  const headers = Object.keys(rows[0]);
  const pairs = detectPhonePairs(headers, '');
  const overflowCols = new Set();
  pairs.slice(1).forEach((p) => {
    if (p.ddd) overflowCols.add(p.ddd);
    overflowCols.add(p.tel);
  });
  if (!overflowCols.size) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    overflowCols.forEach((col) => {
      if (action === 'exclude') delete copy[col];
      else copy[col] = '';
    });
    return copy;
  });
}

// Funde o DDD e o Telefone (o único par que sobra depois do
// applyPhoneOverflowRule) numa coluna só, só dígitos. Só se aplica no
// arquivo final (download/API) — o arquivo enviado à higienizadora continua
// com CPF;DDD;Telefone separados (mailingNormalizer.js). Se o layout já é
// "junto" (DDD embutido no telefone, sem coluna DDD separada), não há nada
// pra fundir.
function mergePhoneColumns(rows) {
  if (!rows.length) return rows;
  const headers = Object.keys(rows[0]);
  const pair = detectPhonePairs(headers, '')[0];
  if (!pair || !pair.ddd) return rows;

  return rows.map((row) => {
    const merged = `${String(row[pair.ddd] ?? '').replace(/\D/g, '')}${String(row[pair.tel] ?? '').replace(/\D/g, '')}`;
    const result = {};
    for (const key of Object.keys(row)) {
      if (key === pair.ddd) continue;
      result[key] = key === pair.tel ? merged : row[key];
    }
    return result;
  });
}

// RF-014: sufixo indicando o filtro aplicado, usado tanto no nome salvo para
// download quanto no nome enviado à API do discador (os dois consomem
// tickets.processed_file_name). Base é o nome do Mailing (não o nome do
// arquivo original que o cliente subiu) — geralmente sem extensão, então
// garante ".csv" quando não tiver nenhuma.
function buildFinalFileName(baseName, filterLevel) {
  const suffix = filterLevel === 'MODERADA' ? '_HIG_MODERADA' : '_HIG_AGRESSIVA';
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex === -1
    ? `${baseName}${suffix}.csv`
    : `${baseName.slice(0, dotIndex)}${suffix}${baseName.slice(dotIndex)}`;
}

module.exports = {
  applyVanguardPattern,
  applyFinazRule,
  applyPhoneOverflowRule,
  mergePhoneColumns,
  buildFinalFileName,
};
