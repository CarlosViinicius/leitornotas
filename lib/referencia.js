// Lê a planilha (somente leitura) para aprender como os nomes já são escritos nela:
// deslintadoras, licenciados, cultivares, clientes e quais NFs já foram lançadas.
// Funciona com o arquivo Excel ou com o Google Planilhas: os dois viram "abas" de linhas x colunas.
const fs = require('fs');
const ExcelJS = require('exceljs');
const { soDigitos } = require('./chave');

const ABAS_AUXILIARES = ['BASE DE DADOS', 'Planilha12', 'Petrovina'];

let cache = { chave: null, dados: null };

function texto(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.result !== undefined) return texto(v.result);
    if (v.text) return String(v.text);
    if (v instanceof Date) return '';
    if (v.formula || v.sharedFormula) return '';
  }
  return String(v).trim();
}

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();

// Guarda, para cada CNPJ, a grafia mais usada na planilha.
function novoCadastro() {
  const contagem = new Map();
  return {
    add(cnpj, razao, cidade, uf) {
      const d = soDigitos(cnpj);
      if (d.length !== 14 || !razao) return;
      const chave = JSON.stringify([razao, cidade, uf]);
      if (!contagem.has(d)) contagem.set(d, new Map());
      const m = contagem.get(d);
      m.set(chave, (m.get(chave) || 0) + 1);
    },
    resultado() {
      const out = new Map();
      for (const [d, m] of contagem) {
        const [melhor] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
        const [razao, cidade, uf] = JSON.parse(melhor);
        out.set(d, { razao, cidade, uf });
      }
      return out;
    },
  };
}

// Arquivo Excel -> { nomeDaAba: [[valores da linha 1], [linha 2], ...] }
async function abasDoExcel(caminho, nomes) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(caminho);
  const abas = {};
  for (const nome of nomes) {
    const ws = wb.getWorksheet(nome);
    if (!ws) continue;
    const linhas = [];
    ws.eachRow((row, r) => {
      const valores = [];
      for (let c = 1; c <= 30; c++) valores.push(texto(row.getCell(c).value));
      linhas[r - 1] = valores;
    });
    abas[nome] = Array.from(linhas, (l) => l || []);
  }
  return abas;
}

function montarReferencia(abas, nomeAba) {
  const principal = abas[nomeAba];
  if (!principal) throw new Error(`A aba "${nomeAba}" não foi encontrada na planilha.`);
  const linhas = (nome, aPartirDe) =>
    (abas[nome] || []).map((l, i) => ({ r: i + 1, c: (col) => texto(l[col - 1]) })).filter((x) => x.r >= aPartirDe);

  const deslint = novoCadastro();
  const licenc = novoCadastro();
  const grafiasCidade = new Map(); // sem acento -> Map(grafia -> vezes)
  const addCidade = (nome) => {
    const n = String(nome || '').trim().toUpperCase();
    if (!n) return;
    const k = semAcento(n);
    if (!grafiasCidade.has(k)) grafiasCidade.set(k, new Map());
    const m = grafiasCidade.get(k);
    m.set(n, (m.get(n) || 0) + 1);
  };
  const cultivarCliente = new Map();
  const nfsLancadas = new Map(); // numero -> [{linha, cnpjs}]

  for (const { r, c } of linhas(nomeAba, 4)) {
    deslint.add(c(7), c(6), c(4), c(5));
    licenc.add(c(13), c(12), c(9), c(10));
    addCidade(c(4));
    addCidade(c(9));
    const cliente = c(1);
    const cultivar = c(17).toUpperCase();
    if (cliente && cultivar && cultivar !== 'NÃO INFORMADO') {
      if (!cultivarCliente.has(cultivar)) cultivarCliente.set(cultivar, new Map());
      const m = cultivarCliente.get(cultivar);
      m.set(cliente, (m.get(cliente) || 0) + 1);
    }
    const nf = soDigitos(c(15)) || soDigitos(c(3));
    if (nf && Number(nf)) {
      const n = String(Number(nf));
      if (!nfsLancadas.has(n)) nfsLancadas.set(n, []);
      nfsLancadas.get(n).push({ linha: r, cnpjs: [soDigitos(c(7)), soDigitos(c(13))], nomes: [c(6), c(12)] });
    }
  }

  // Abas auxiliares (ocultas) que também listam deslintadoras e licenciados.
  for (const { c } of linhas('Planilha12', 7)) {
    deslint.add(c(2), c(1), c(3), c(4));
    addCidade(c(3));
  }
  for (const { c } of linhas('Petrovina', 2)) {
    deslint.add(c(6), c(5), c(3), c(4));
    licenc.add(c(13), c(12), c(8), c(9));
    addCidade(c(3));
    addCidade(c(8));
  }

  // Grafia mais usada de cada cidade (a com acento ganha o empate).
  const cidades = new Map();
  for (const [k, m] of grafiasCidade) {
    const [melhor] = [...m.entries()].sort((a, b) => b[1] - a[1] || Number(b[0] !== semAcento(b[0])) - Number(a[0] !== semAcento(a[0])))[0];
    cidades.set(k, melhor);
  }

  // BASE DE DADOS: listas oficiais de clientes, safras, cultivares (com código RNC) e licenciados.
  const clientes = [];
  const safras = [];
  const cultivares = []; // {nome, rnc}
  const licenciadosNomes = [];
  for (const { c } of linhas('BASE DE DADOS', 2)) {
    if (c(1)) clientes.push(c(1));
    if (c(3)) safras.push(c(3));
    if (c(5)) cultivares.push({ nome: c(5).toUpperCase(), rnc: c(6).toUpperCase() });
    if (c(9)) licenciadosNomes.push(c(9));
  }

  const cultivarParaCliente = new Map();
  for (const [cult, m] of cultivarCliente) {
    cultivarParaCliente.set(cult, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  }

  return {
    deslintadoras: deslint.resultado(),
    licenciados: licenc.resultado(),
    cultivarParaCliente,
    nfsLancadas,
    clientes,
    safras,
    cultivares,
    licenciadosNomes,
    cidades,
  };
}

// lerAbasGoogle: função que busca as abas no Google (vem de lib/google.js).
async function carregarReferencia(config, lerAbasGoogle) {
  const nomes = [config.aba, ...ABAS_AUXILIARES];
  if (config.destino === 'google') {
    const chave = `google:${config.googleUrl}:${config.aba}`;
    if (cache.chave === chave && Date.now() - cache.quando < 15000) return cache.dados;
    const dados = montarReferencia(await lerAbasGoogle(nomes), config.aba);
    cache = { chave, quando: Date.now(), dados };
    return dados;
  }
  const chave = `excel:${config.planilha}:${config.aba}:${fs.statSync(config.planilha).mtimeMs}`;
  if (cache.chave === chave) return cache.dados;
  const dados = montarReferencia(await abasDoExcel(config.planilha, nomes), config.aba);
  cache = { chave, dados };
  return dados;
}

function esquecerReferencia() {
  cache = { chave: null, dados: null };
}

// Texto com as listas, para a IA usar a mesma grafia da planilha.
function referenciaComoTexto(ref) {
  const linhas = [];
  linhas.push('DESLINTADORAS já cadastradas (razão social | CNPJ | cidade | UF):');
  for (const [d, v] of ref.deslintadoras) linhas.push(`- ${v.razao} | ${d} | ${v.cidade} | ${v.uf}`);
  linhas.push('', 'LICENCIADOS já cadastrados (razão social | CNPJ | cidade | UF):');
  for (const [d, v] of ref.licenciados) linhas.push(`- ${v.razao} | ${d} | ${v.cidade} | ${v.uf}`);
  linhas.push('', 'Outros licenciados conhecidos: ' + ref.licenciadosNomes.join('; '));
  linhas.push('', 'CULTIVARES (nome na planilha = código que pode aparecer na nota):');
  for (const c of ref.cultivares) linhas.push(`- ${c.nome} = ${c.rnc || '-'}`);
  linhas.push('', 'CLIENTES possíveis: ' + ref.clientes.join(', '));
  linhas.push('', 'Cliente usado para cada cultivar até hoje:');
  for (const [cult, cli] of ref.cultivarParaCliente) linhas.push(`- ${cult}: ${cli}`);
  return linhas.join('\n');
}

module.exports = { carregarReferencia, esquecerReferencia, referenciaComoTexto };
