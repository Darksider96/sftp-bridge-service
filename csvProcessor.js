// Porta CommonJS de src/lib/centrifuge/csvProcessor.ts (processCentrifugeReturn).
// Mesma lógica — mantenha as duas versões em sincronia se uma mudar.

/**
 * Motor de Retorno (PROCV Automático)
 * @param {Record<string,string>[]} originalData Dados da planilha bruta do cliente
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

  // Busca nomes de colunas na planilha retornada (case insensitive)
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

  // 3. Preparar a leitura das colunas de telefone da planilha original
  const origHeaders = Object.keys(originalData[0]);
  const dddCols = origHeaders.filter(h => h.toLowerCase().includes('ddd'));
  const telCols = origHeaders.filter(h => h.toLowerCase().includes('tel') || h.toLowerCase().includes('celular'));

  const pairs = [];
  telCols.forEach((telCol, index) => {
    pairs.push({ ddd: dddCols[index], tel: telCol });
  });

  // 4. O PROCV: Filtrar a base original
  const finalResult = [];

  for (const row of originalData) {
    let hasValidPhone = false;

    // Verifica se algum dos telefones dessa linha está na Lista VIP
    for (const pair of pairs) {
      const rawPhone = row[pair.tel] || '';
      const rawDdd = pair.ddd ? (row[pair.ddd] || '') : '';
      const fullNumber = `${rawDdd}${rawPhone}`.replace(/\D/g, '');

      if (validPhones.has(fullNumber)) {
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
