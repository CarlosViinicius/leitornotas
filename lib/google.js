// Ligação com o Google Planilhas por meio de um Apps Script colado na própria planilha.
// O script recebe as linhas pelo link "/exec" e escreve na primeira linha vazia da aba.

// Aumente quando o código do Apps Script mudar: o programa avisa para atualizar.
const VERSAO_SCRIPT = 3; // 3: ação "limpar" (desfazer inserção)
const VERSAO_MINIMA_INSERIR = 2; // inserir funciona desde a 2: não obriga a atualizar só por causa do desfazer

function codigoAppsScript(token) {
  return `// Leitor de Notas - cole este código em Extensões > Apps Script da planilha.
const CODIGO_ACESSO = '${token}';
const VERSAO = ${VERSAO_SCRIPT};
const PRIMEIRA_LINHA = 4;
const COLUNAS = 25; // A até Y

function doGet() {
  return resposta({ ok: true, versao: VERSAO, planilha: SpreadsheetApp.getActiveSpreadsheet().getName() });
}

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (p.token !== CODIGO_ACESSO) return resposta({ erro: 'Código de acesso errado. Copie o código do Apps Script de novo pelo Leitor de Notas.' });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (p.acao === 'ler') {
      const abas = {};
      p.abas.forEach(function (nome) {
        const aba = ss.getSheetByName(nome);
        if (aba && aba.getLastRow() > 0) abas[nome] = aba.getRange(1, 1, aba.getLastRow(), Math.max(aba.getLastColumn(), 1)).getDisplayValues();
      });
      return resposta({ abas: abas, versao: VERSAO, planilha: ss.getName() });
    }
    if (p.acao === 'inserir') {
      const trava = LockService.getScriptLock();
      trava.waitLock(30000);
      try {
        return resposta({ linhas: inserir(ss, p.aba, p.linhas), versao: VERSAO });
      } finally {
        trava.releaseLock();
      }
    }
    if (p.acao === 'limpar') {
      const trava = LockService.getScriptLock();
      trava.waitLock(30000);
      try {
        limpar(ss, p.aba, p.conferencias);
        return resposta({ ok: true, versao: VERSAO });
      } finally {
        trava.releaseLock();
      }
    }
    return resposta({ erro: 'Ação desconhecida.' });
  } catch (err) {
    return resposta({ erro: String((err && err.message) || err) });
  }
}

function inserir(ss, nomeAba, linhas) {
  const aba = ss.getSheetByName(nomeAba);
  if (!aba) throw new Error('A aba "' + nomeAba + '" não foi encontrada na planilha.');
  const ultima = Math.max(aba.getLastRow(), PRIMEIRA_LINHA);
  const faixa = aba.getRange(PRIMEIRA_LINHA, 1, ultima - PRIMEIRA_LINHA + 1, COLUNAS);
  const valores = faixa.getValues();
  const formulas = faixa.getFormulas();
  // Última linha com algo digitado (células só com fórmula não contam).
  let ultimaComDados = PRIMEIRA_LINHA - 1;
  for (let i = 0; i < valores.length; i++) {
    if (valores[i].some(function (v, j) { return v !== '' && formulas[i][j] === ''; })) ultimaComDados = PRIMEIRA_LINHA + i;
  }
  const inicio = ultimaComDados + 1;
  const fim = inicio + linhas.length - 1;
  if (fim > aba.getMaxRows()) aba.insertRowsAfter(aba.getMaxRows(), fim - aba.getMaxRows());
  const destino = aba.getRange(inicio, 1, linhas.length, COLUNAS);
  const formulasDestino = destino.getFormulas();
  // Fórmulas que já existem nas linhas (ex.: coluna O) são mantidas.
  const novos = linhas.map(function (linha, i) {
    return linha.map(function (v, j) { return formulasDestino[i][j] || v; });
  });
  // Listas suspensas (validação) recusariam nomes novos e cortariam a linha no meio.
  // Tira a validação, grava a linha inteira e devolve a validação: o valor fora da lista
  // fica marcado na planilha para conferir, como no Excel.
  const validacoes = destino.getDataValidations();
  destino.clearDataValidations();
  try {
    destino.setValues(novos);
  } finally {
    destino.setDataValidations(validacoes);
  }
  const numeros = [];
  for (let r = inicio; r <= fim; r++) numeros.push(r);
  return numeros;
}

// Desfazer: apaga os valores das linhas (fórmulas ficam), só se ainda forem daquela NF e CNPJ.
function limpar(ss, nomeAba, conferencias) {
  const aba = ss.getSheetByName(nomeAba);
  if (!aba) throw new Error('A aba "' + nomeAba + '" não foi encontrada na planilha.');
  const digitos = function (s) { return String(s).replace(/\\D/g, ''); };
  conferencias.forEach(function (c) {
    const v = aba.getRange(c.linha, 1, 1, COLUNAS).getDisplayValues()[0];
    if (digitos(v[2]) !== c.nf || digitos(v[6]) !== c.cnpj) {
      throw new Error('A linha ' + c.linha + ' da planilha não tem mais a NF ' + c.nf + ' (alguém mexeu nela depois). Não apaguei nada; desfaça direto na planilha.');
    }
  });
  conferencias.forEach(function (c) {
    const formulas = aba.getRange(c.linha, 1, 1, COLUNAS).getFormulas()[0];
    formulas.forEach(function (f, j) { if (!f) aba.getRange(c.linha, j + 1).clearContent(); });
  });
}

function resposta(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
`;
}

async function chamar(config, corpo) {
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(String(config.googleUrl || '').trim())) {
    throw new Error('O link do Google em Configurações precisa ser o link do Apps Script, terminando em /exec.');
  }
  let r;
  try {
    r = await fetch(config.googleUrl.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: config.googleToken, ...corpo }),
      redirect: 'follow',
    });
  } catch {
    throw new Error('Sem conexão com o Google. Confira a internet.');
  }
  const txt = await r.text();
  let j;
  try {
    j = JSON.parse(txt);
  } catch {
    throw new Error('O Google não respondeu como esperado. Confira se o Apps Script foi implantado como "App da Web" com acesso para "Qualquer pessoa".');
  }
  if (j.erro) throw new Error(j.erro);
  return j;
}

function scriptDesatualizado(j, minima = VERSAO_SCRIPT) {
  return !(j.versao >= minima);
}

const MSG_ATUALIZAR = 'Em Configurações, clique em "Copiar código", cole no Apps Script e faça uma nova versão da implantação.';

async function lerAbasGoogle(config, nomes) {
  const j = await chamar(config, { acao: 'ler', abas: nomes });
  return j.abas;
}

// Datas e horas vão como número (igual o Excel guarda), assim não tem problema de fuso horário.
function paraValorGoogle(v) {
  if (v == null) return '';
  if (typeof v === 'object' && v.data) {
    const [d, m, a] = v.data.split('/').map(Number);
    return (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  }
  if (typeof v === 'object' && v.hora) {
    const [h, mi, s] = v.hora.split(':').map(Number);
    return ((h || 0) * 3600 + (mi || 0) * 60 + (s || 0)) / 86400;
  }
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v; // evita virar fórmula
  return v;
}

async function inserirLinhasGoogle(config, linhas) {
  const COLUNAS = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('');
  const matriz = linhas.map((l) => COLUNAS.map((c) => paraValorGoogle(l[c])));
  const teste = await chamar(config, { acao: 'ler', abas: [] });
  if (scriptDesatualizado(teste, VERSAO_MINIMA_INSERIR)) throw new Error('O código do Apps Script da planilha está desatualizado. ' + MSG_ATUALIZAR);
  const j = await chamar(config, { acao: 'inserir', aba: config.aba, linhas: matriz });
  return j.linhas;
}

async function limparLinhasGoogle(config, conferencias) {
  const teste = await chamar(config, { acao: 'ler', abas: [] });
  if (scriptDesatualizado(teste)) throw new Error('Para desfazer no Google Planilhas, o código do Apps Script precisa ser atualizado. ' + MSG_ATUALIZAR);
  await chamar(config, { acao: 'limpar', aba: config.aba, conferencias });
}

module.exports = { codigoAppsScript, lerAbasGoogle, inserirLinhasGoogle, limparLinhasGoogle };
