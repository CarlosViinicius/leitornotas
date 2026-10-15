// Chave de acesso da NF-e (44 dígitos): validação do dígito verificador e leitura dos campos.

function soDigitos(s) {
  return String(s || '').replace(/\D/g, '');
}

function chaveValida(chave) {
  const ch = soDigitos(chave);
  if (ch.length !== 44) return false;
  let soma = 0;
  let peso = 2;
  for (let i = 42; i >= 0; i--) {
    soma += Number(ch[i]) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }
  const resto = soma % 11;
  const dv = resto < 2 ? 0 : 11 - resto;
  return dv === Number(ch[43]);
}

function lerChave(chave) {
  const ch = soDigitos(chave);
  if (ch.length !== 44) return null;
  return {
    uf: ch.slice(0, 2),
    ano: 2000 + Number(ch.slice(2, 4)),
    mes: Number(ch.slice(4, 6)),
    cnpjEmitente: ch.slice(6, 20),
    modelo: ch.slice(20, 22),
    serie: Number(ch.slice(22, 25)),
    numero: Number(ch.slice(25, 34)),
  };
}

function formatarCnpj(cnpj) {
  const d = soDigitos(cnpj);
  if (d.length !== 14) return String(cnpj || '').trim();
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

// Código IBGE da UF: são os 2 primeiros dígitos da chave.
const CODIGO_UF = {
  RO: '11', AC: '12', AM: '13', RR: '14', PA: '15', AP: '16', TO: '17', MA: '21', PI: '22', CE: '23', RN: '24',
  PB: '25', PE: '26', AL: '27', SE: '28', BA: '29', MG: '31', ES: '32', RJ: '33', SP: '35', PR: '41', SC: '42',
  RS: '43', MS: '50', MT: '51', GO: '52', DF: '53',
};

// Os primeiros 34 dígitos da chave repetem dados impressos na nota:
// UF (2) + AAMM da emissão (4) + CNPJ do emitente (14) + modelo 55 (2) + série (3) + número (9).
// Devolve o que der para montar a partir do que a IA leu nos outros campos ([posição, texto]).
function partesDaNota(dados) {
  const partes = [];
  const emit = dados.emitente || {};
  const uf = CODIGO_UF[String(emit.uf || '').trim().toUpperCase()];
  if (uf) partes.push([0, uf]);
  const data = String(dados.data_emissao || '').match(/^\s*\d{1,2}\/(\d{1,2})\/(\d{4})/);
  if (data) partes.push([2, data[2].slice(2) + data[1].padStart(2, '0')]);
  let doc = soDigitos(emit.cnpj);
  if (doc.length === 11) doc = '000' + doc; // emitente pessoa física: CPF com zeros na frente
  if (doc.length === 14) partes.push([6, doc]);
  partes.push([20, '55']);
  const serie = soDigitos(dados.serie);
  if (serie && serie.length <= 3) partes.push([22, serie.padStart(3, '0')]);
  const numero = Number(dados.numero_nf) || 0;
  if (numero > 0 && numero < 1e9) partes.push([25, String(numero).padStart(9, '0')]);
  return partes;
}

// Tenta achar a chave certa quando as leituras não conferem. Cada dígito é "votado" pelas leituras
// da chave (peso 1) e pelos dados impressos na nota (peso 1,5: letra maior, a IA erra menos).
// Onde houver empate, testa as combinações; só aceita se exatamente uma conferir no dígito verificador.
function consertarChave(leituras, dados) {
  const votos = Array.from({ length: 44 }, () => new Map());
  // "?" = dígito que a IA não conseguiu ler: ocupa o lugar, mas não vota.
  const votar = (i, dig, peso) => { if (dig !== '?') votos[i].set(dig, (votos[i].get(dig) || 0) + peso); };
  for (const l of leituras.map((x) => String(x || '').replace(/[^\d?]/g, ''))) {
    if (l.length === 44) for (let i = 0; i < 44; i++) votar(i, l[i], 1);
    // Com um dígito a mais ou a menos, só o final (depois do nº da nota) ainda fica no lugar certo.
    else if (l.length >= 40 && l.length <= 48) for (let i = 34; i < 44; i++) votar(i, l[l.length - 44 + i], 1);
  }
  for (const [ini, txt] of partesDaNota(dados)) for (let k = 0; k < txt.length; k++) votar(ini + k, txt[k], 1.5);
  if (votos.some((v) => !v.size)) return null;
  const opcoes = votos.map((v) => {
    const max = Math.max(...v.values());
    return [...v.keys()].filter((d) => v.get(d) === max);
  });
  const empates = opcoes.map((o, i) => (o.length > 1 ? i : -1)).filter((i) => i >= 0);
  if (empates.length > 3) return null;
  let candidatas = [opcoes.map((o) => o[0])];
  for (const i of empates) candidatas = candidatas.flatMap((c) => opcoes[i].map((d) => { const n = [...c]; n[i] = d; return n; }));
  const certas = [...new Set(candidatas.map((c) => c.join('')).filter(chaveValida))];
  return certas.length === 1 ? certas[0] : null;
}

module.exports = { soDigitos, chaveValida, lerChave, formatarCnpj, consertarChave };
