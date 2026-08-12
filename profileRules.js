// Regras fixas por cliente (layout_profile), aplicadas no arquivo final
// pós-PROCV em checkRetorno.js. Nenhuma delas depende do layout do arquivo —
// DDD/Telefone continuam 100% detectados por heurística em csvProcessor.js.
const { detectPhonePairs } = require('./mailingNormalizer');

// O discador (Argus/Dazsoft) geralmente só reconhece/casa o cliente do lado
// deles se o CODIGO vier em minúsculo. O arquivo original do cliente às vezes
// chega com essa coluna em maiúsculo, então normaliza no arquivo final antes
// de disponibilizar pra envio — sem isso o discador não reconhece o registro
// mesmo com o cruzamento de telefone correto. A caixa é configurável por
// layout_profile (campo codigo_column_case); sem perfil vinculado ao
// cliente, mantém o padrão histórico (minúscula).
function applyCodigoColumnCase(rows, columnCase) {
  if (!rows.length) return rows;
  const codigoKey = Object.keys(rows[0]).find(
    (h) => h.toLowerCase().includes('codigo') || h.toLowerCase().includes('código')
  );
  if (!codigoKey) return rows;
  const transform = columnCase === 'upper' ? (v) => v.toUpperCase() : (v) => v.toLowerCase();
  return rows.map((row) => ({ ...row, [codigoKey]: transform(String(row[codigoKey] ?? '')) }));
}

// Regra FINAZ: duplica o valor da primeira coluna ID/CÓDIGO/FINAZ em duas
// colunas novas (CodigoFinaz, ProspeccaoId) no início do arquivo, removendo a
// coluna original. Configurável por layout_profile (campo is_finaz).
function applyFinazRule(rows) {
  if (!rows.length) return rows;
  const headers = Object.keys(rows[0]);
  const idColumn = headers.find((h) => /id|codigo|código|finaz/i.test(h)) || headers[0];
  return rows.map((row) => {
    const { [idColumn]: idValue, ...rest } = row;
    return { CodigoFinaz: idValue ?? '', ProspeccaoId: idValue ?? '', ...rest };
  });
}

// Alguns clientes têm um CRM/URA que só suporta um número fixo de telefones,
// mas o mailing pode ter mais colunas de telefone do que isso (a detecção de
// qual coluna é telefone continua 100% automática — detectPhonePairs, a
// mesma heurística usada no resto do pipeline). O excedente (colunas de
// telefone além de maxPhoneColumns) é excluído ou esvaziado, configurável por
// layout_profile (campos max_phone_columns/phone_overflow_action).
function applyPhoneOverflowRule(rows, maxPhoneColumns, action) {
  if (!rows.length || !maxPhoneColumns) return rows;
  const headers = Object.keys(rows[0]);
  const pairs = detectPhonePairs(headers, '');
  const overflowCols = new Set();
  pairs.slice(maxPhoneColumns).forEach((p) => {
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

module.exports = { applyCodigoColumnCase, applyFinazRule, applyPhoneOverflowRule };
