// Porta CommonJS de src/lib/centrifuge/csvProcessor.ts (processCentrifugeReturn).
// Mesma lógica — mantenha as duas versões em sincronia se uma mudar.

const { detectPhonePairs, extractDddTelefone } = require('./mailingNormalizer');

/**
 * Motor de Retorno (PROCV Automático)
 * @param {Record<string,string>[]} originalData Dados da planilha bruta do cliente — já deve ter
 *   passado por parseMailingCsv() (não Papa.parse cru), senão arquivos sem cabeçalho (ex: "finaz")
 *   perdem a primeira linha e o pareamento de colunas abaixo não acha nenhum telefone.
 * @param {Record<string,string>[]} returnedData Dados devolvidos pela higienizadora (com coluna Score)
 * @param {'AGRESSIVA'|'MODERADA'} filterLevel Agressiva (corta 0,1,2) ou Moderada (corta 0,1)
 * @returns {Record<string,string>[]}
 */
function processCentrifugeReturn(originalData, returnedData, filterLevel = 'AGRESSIVA') {
  if (!originalData.length || !returnedData.length) return [];

  // 1. Definir a nota de corte
  // Agressiva: Aceita > 2 (ou seja, 3, 4, 5...)
  // Moderada: Aceita > 1 (ou seja, 2, 3, 4, 5...)
  const minScore = filterLevel === 'AGRESSIVA' ? 3 : 2;

  // 2. Criar a "Lista VIP" de telefones aprovados
  const validPhones = new Set();

  // Busca nomes de colunas na planilha retornada (case insensitive). O arquivo
  // retornado é sempre o nosso próprio formato (CPF;DDD;Telefone + Score
  // anexado pela higienizadora), então não precisa do motor de detecção.
  const retHeaders = Object.keys(returnedData[0]);
  const scoreCol = retHeaders.find(h => h.toLowerCase().includes('score')) || 'Score';
  const retDddCol = retHeaders.find(h => h.toLowerCase() === 'ddd') || 'DDD';
  const retTelCol = retHeaders.find(h => h.toLowerCase().includes('tel')) || 'Telefone';

  for (const row of returnedData) {
    const score = parseInt(row[scoreCol] || '0', 10);

    // Se o score for maior ou igual a nota de corte, entra na Lista VIP
    if (score >= minScore) {
      const ddd = (row[retDddCol] || '').replace(/\D/g, '');
      const tel = (row[retTelCol] || '').replace(/\D/g, '');
      const fullNumber = `${ddd}${tel}`;

      if (fullNumber.length >= 10) {
        validPhones.add(fullNumber);
      }
    }
  }

  // 3. Preparar a leitura das colunas de telefone da planilha original, com o
  // mesmo motor usado no envio (mailingNormalizer): pareia por sufixo
  // numérico, aceita DDD chumbado no telefone e funciona mesmo com as colunas
  // sintéticas que parseMailingCsv gera pra arquivo sem cabeçalho. Não precisa
  // detectar a coluna de id aqui (só quais colunas são ddd/telefone), então
  // passa uma string vazia — nenhum header real deve casar com isso — em vez
  // de detectIdColumn, senão ele podia "roubar" a própria coluna DDD como se
  // fosse o id e excluí-la do pareamento.
  // Regra fixa (RF-003): só o primeiro telefone detectado conta pra aprovar
  // a linha — é o único que de fato foi enviado à higienização (mesma regra
  // aplicada no motor de envio, mailingNormalizer.js/normalizeMailing).
  const origHeaders = Object.keys(originalData[0]);
  const pairs = detectPhonePairs(origHeaders, '').slice(0, 1);

  // 4. O PROCV: Filtrar a base original
  const finalResult = [];

  for (const row of originalData) {
    let hasValidPhone = false;

    // Verifica se algum dos telefones dessa linha está na Lista VIP
    for (const pair of pairs) {
      const rawPhone = row[pair.tel] || '';
      const rawDdd = pair.ddd ? (row[pair.ddd] || '') : '';
      const extracted = extractDddTelefone(rawDdd, rawPhone);
      if (extracted && validPhones.has(`${extracted.ddd}${extracted.telefone}`)) {
        hasValidPhone = true;
        break; // Achou um telefone bom, já pode salvar o cliente e ir pro próximo
      }
    }

    // Se o cliente tem telefone aprovado, vai para a base final higienizada!
    if (hasValidPhone) {
      finalResult.push(row);
    }
  }

  return finalResult;
}

module.exports = { processCentrifugeReturn };
