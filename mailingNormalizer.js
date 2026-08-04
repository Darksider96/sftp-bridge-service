// Porta CommonJS de src/lib/centrifuge/mailingNormalizer.ts.
// Mesma lógica — mantenha as duas versões em sincronia se uma mudar.

const Papa = require('papaparse');

/**
 * Motor de Envio (padronização de mailing)
 *
 * Cada cliente manda a planilha no seu próprio padrão: nomes de coluna
 * diferentes, DDD às vezes numa coluna separada e às vezes "chumbado" junto
 * do telefone, e às vezes mais de um telefone por linha (Telefone1/Telefone2,
 * Celular/Residencial etc). Este módulo normaliza qualquer uma dessas
 * variações para o layout que a higienizadora espera: uma linha por telefone
 * válido, com ID do cliente, DDD e Telefone já separados e limpos.
 */

// DDDs válidos no Brasil (fonte: ANATEL). Usado para diferenciar um DDD real
// de dígitos que por coincidência caem numa faixa de tamanho válida.
const VALID_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24,
  27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46,
  47, 48, 49,
  51, 53, 54, 55,
  61,
  62, 64,
  63,
  65, 66,
  67,
  68,
  69,
  71, 73, 74, 75, 77,
  79,
  81, 87,
  82,
  83,
  84,
  85, 88,
  86, 89,
  91, 93, 94,
  92, 97,
  95,
  96,
  98, 99,
]);

const ID_COLUMN_CANDIDATES = ['cpf', 'cnpj', 'id', 'matricula', 'matrícula', 'contrato', 'codigo', 'código', 'cliente'];

function onlyDigits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function normalizeHeader(header) {
  return header.trim().toLowerCase();
}

function isValidDdd(dddDigits) {
  if (dddDigits.length !== 2) return false;
  return VALID_DDDS.has(parseInt(dddDigits, 10));
}

// Telefone fixo tem 8 dígitos (começa em 2-9), celular tem 9 (começa
// sempre em 9 desde a migração da Anatel). Essas regras de primeiro dígito
// são o que evita confundir uma coluna de ID/matrícula (mesmo tamanho depois
// de combinar com um "DDD" de 2 dígitos) com telefone de verdade.
function isValidPhone(telDigits) {
  if (new Set(telDigits.split('')).size === 1) return false; // ex: 999999999
  if (telDigits.length === 9) return telDigits[0] === '9';
  if (telDigits.length === 8) return telDigits[0] >= '2' && telDigits[0] <= '9';
  return false;
}

// Remove código do país (55) e prefixo de tronco (0) quando presentes,
// deixando só DDD+telefone (10 ou 11 dígitos).
function stripCountryAndTrunk(digits) {
  let d = digits;
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length > 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

/** Extrai um trailing number de um nome de coluna, ex: "Telefone 2" -> 2. */
function trailingNumber(header) {
  const match = header.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : null;
}

function detectIdColumn(headers, explicitIdColumn) {
  if (explicitIdColumn && headers.includes(explicitIdColumn)) return explicitIdColumn;

  for (const candidate of ID_COLUMN_CANDIDATES) {
    const exact = headers.find((h) => normalizeHeader(h) === candidate);
    if (exact) return exact;
  }
  for (const candidate of ID_COLUMN_CANDIDATES) {
    const partial = headers.find((h) => normalizeHeader(h).includes(candidate));
    if (partial) return partial;
  }
  return headers[0];
}

/**
 * Identifica os pares (coluna DDD, coluna telefone) do arquivo.
 *
 * Estratégia: colunas de telefone/DDD com o mesmo sufixo numérico são
 * pareadas entre si (ex: "DDD 2" com "Celular 2"). As colunas restantes
 * (sem sufixo, ou sufixo sem par do outro lado) são pareadas por posição,
 * na ordem em que aparecem. Toda coluna de telefone entra na lista, mesmo
 * sem DDD pareado — o DDD pode estar embutido no próprio número.
 */
function detectPhonePairs(headers, idColumn) {
  const dddCols = headers.filter((h) => h !== idColumn && normalizeHeader(h).includes('ddd'));
  const telCols = headers.filter((h) => {
    if (h === idColumn) return false;
    const n = normalizeHeader(h);
    return !n.includes('ddd') && (n.includes('tel') || n.includes('cel') || n.includes('fone'));
  });

  const dddBySuffix = new Map();
  const dddWithoutSuffix = [];
  for (const col of dddCols) {
    const n = trailingNumber(col);
    if (n !== null) dddBySuffix.set(n, col);
    else dddWithoutSuffix.push(col);
  }

  const pairs = [];
  let unpaired = 0;
  for (const telCol of telCols) {
    const n = trailingNumber(telCol);
    if (n !== null && dddBySuffix.has(n)) {
      pairs.push({ ddd: dddBySuffix.get(n), tel: telCol });
      dddBySuffix.delete(n);
    } else {
      pairs.push({ ddd: dddWithoutSuffix[unpaired] || null, tel: telCol });
      if (dddWithoutSuffix[unpaired]) unpaired++;
    }
  }

  return pairs;
}

/** Combina um par bruto (ddd, telefone) em {ddd, telefone} limpos, ou null se inválido. */
function extractDddTelefone(rawDdd, rawTel) {
  const dddDigits = onlyDigits(rawDdd);
  const telDigits = onlyDigits(rawTel);

  if (dddDigits) {
    const cleanTel = stripCountryAndTrunk(telDigits);
    if (isValidDdd(dddDigits) && isValidPhone(cleanTel)) {
      return { ddd: dddDigits, telefone: cleanTel };
    }
  }

  // Sem DDD separado (ou DDD/telefone não bateram) — tenta extrair do
  // número combinado, que é o caso do DDD "chumbado" no telefone.
  const combined = stripCountryAndTrunk(dddDigits ? `${dddDigits}${telDigits}` : telDigits);
  if (combined.length === 10 || combined.length === 11) {
    const extractedDdd = combined.slice(0, 2);
    const extractedTel = combined.slice(2);
    if (isValidDdd(extractedDdd) && isValidPhone(extractedTel)) {
      return { ddd: extractedDdd, telefone: extractedTel };
    }
  }

  return null;
}

/**
 * @param {Record<string,string>[]} rows Linhas cruas da planilha do cliente (já parseadas, com header)
 * @param {{ idColumn?: string, dedupeAcrossFile?: boolean }} [options]
 *   idColumn: força qual coluna usar como identificador (senão auto-detecta).
 *   dedupeAcrossFile: descarta telefones repetidos entre linhas diferentes, não só dentro da mesma linha.
 * @returns {{ rows: {id: string, ddd: string, telefone: string}[], report: object }}
 */
function normalizeMailing(rows, options = {}) {
  const report = {
    totalRows: rows.length,
    rowsWithPhone: 0,
    rowsWithoutPhone: 0,
    phonesExtracted: 0,
    duplicatesSkipped: 0,
    invalidSkipped: 0,
  };

  if (!rows.length) return { rows: [], report };

  const headers = Object.keys(rows[0]);
  const idColumn = detectIdColumn(headers, options.idColumn);
  const pairs = detectPhonePairs(headers, idColumn);

  if (!pairs.length) {
    throw new Error('Nenhuma coluna de telefone/DDD encontrada no arquivo');
  }

  const output = [];
  const seenGlobal = options.dedupeAcrossFile ? new Set() : null;

  for (const row of rows) {
    const id = row[idColumn] ?? '';
    const seenInRow = new Set();
    let foundAny = false;

    for (const pair of pairs) {
      const rawTel = row[pair.tel] ?? '';
      const rawDdd = pair.ddd ? row[pair.ddd] ?? '' : '';
      if (!onlyDigits(rawTel) && !onlyDigits(rawDdd)) continue;

      const extracted = extractDddTelefone(rawDdd, rawTel);
      if (!extracted) {
        report.invalidSkipped++;
        continue;
      }

      const key = `${extracted.ddd}${extracted.telefone}`;
      if (seenInRow.has(key)) continue;
      seenInRow.add(key);

      if (seenGlobal) {
        if (seenGlobal.has(key)) {
          report.duplicatesSkipped++;
          continue;
        }
        seenGlobal.add(key);
      }

      output.push({ id: String(id), ddd: extracted.ddd, telefone: extracted.telefone });
      report.phonesExtracted++;
      foundAny = true;
    }

    if (foundAny) report.rowsWithPhone++;
    else report.rowsWithoutPhone++;
  }

  return { rows: output, report };
}

// Palavras que só aparecem num cabeçalho de verdade (nome de coluna), nunca
// num CPF/telefone/nome de pessoa. Usado só para decidir se a primeira linha
// do arquivo é cabeçalho ou já é dado — não usado para escolher qual coluna é
// qual (isso é papel de detectIdColumn/detectPhonePairs).
const HEADER_KEYWORDS = ['ddd', 'tel', 'cel', 'fone', 'phone', ...ID_COLUMN_CANDIDATES, 'nome'];

function looksLikeRealHeader(headerFields) {
  return headerFields.some((h) => HEADER_KEYWORDS.some((k) => normalizeHeader(String(h)).includes(k)));
}

/** Amostra os valores de uma coluna (por posição) e decide se parecem telefone. */
function looksLikePhoneColumn(values) {
  const nonEmpty = values.filter((v) => onlyDigits(v).length > 0);
  if (nonEmpty.length === 0) return false;
  const validCount = nonEmpty.filter((v) => extractDddTelefone('', v) !== null).length;
  return validCount / nonEmpty.length >= 0.5;
}

/**
 * Alguns clientes mandam arquivo sem nenhuma linha de cabeçalho (ex: layout
 * "finaz": id;nome;telefone1;telefone2;telefone3;telefone4;telefone5, direto
 * com dado na primeira linha). Sem cabeçalho pra ler nome de coluna, a única
 * forma de saber o papel de cada posição é olhar o formato dos valores:
 * colunas onde a maioria dos valores "parece telefone" viram telefone_N (na
 * ordem em que aparecem); a primeira coluna que sobra vira o id (mesma regra
 * de fallback que detectIdColumn já usa: primeira coluna quando nada bate por
 * nome); o resto é ignorado.
 */
function synthesizeRowsFromPositions(rawRows) {
  if (!rawRows.length) return [];

  const numCols = Math.max(...rawRows.map((r) => r.length));
  const colNames = [];
  let phoneIdx = 0;
  let idAssigned = false;

  for (let c = 0; c < numCols; c++) {
    const values = rawRows.map((r) => r[c] || '');
    if (looksLikePhoneColumn(values)) {
      phoneIdx++;
      colNames[c] = `telefone_${phoneIdx}`;
    } else if (!idAssigned) {
      colNames[c] = 'id';
      idAssigned = true;
    } else {
      colNames[c] = `campo_${c}`;
    }
  }

  return rawRows.map((row) => {
    const obj = {};
    colNames.forEach((name, c) => {
      obj[name] = row[c] || '';
    });
    return obj;
  });
}

/**
 * Faz o parse do CSV pro formato que normalizeMailing espera, detectando
 * automaticamente se o arquivo tem uma linha de cabeçalho de verdade ou não.
 * @param {string} text
 * @returns {Record<string,string>[]}
 */
function parseMailingCsv(text) {
  const withHeader = Papa.parse(text, { header: true, skipEmptyLines: true });
  const headerFields = withHeader.meta.fields || [];

  if (headerFields.length === 0 || looksLikeRealHeader(headerFields)) {
    return withHeader.data;
  }

  // O que o Papa leu como "cabeçalho" era, na verdade, a primeira linha de
  // dado — reprocessa sem header pra não perder essa linha.
  const raw = Papa.parse(text, { header: false, skipEmptyLines: true });
  return synthesizeRowsFromPositions(raw.data);
}

module.exports = {
  normalizeMailing,
  extractDddTelefone,
  detectIdColumn,
  detectPhonePairs,
  parseMailingCsv,
};
