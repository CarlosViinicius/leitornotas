// Grava linhas novas na aba da planilha mexendo só no XML dessa aba.
// O resto do arquivo (outras abas, fórmulas, vínculos, formatação condicional) fica intacto.
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const os = require('os');
const { execFile } = require('child_process');

const COLUNAS = 'ABCDEFGHIJKLMNOPQRSTUVWXY'.split('');
const PRIMEIRA_LINHA_DADOS = 4;

function escaparXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

function colunaParaNumero(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

// Valores aceitos: número, texto, {data: 'DD/MM/AAAA'}, {hora: 'HH:MM[:SS]'}.
function celulaXml(ref, estilo, valor) {
  const s = estilo != null ? ` s="${estilo}"` : '';
  if (valor == null || valor === '') return `<c r="${ref}"${s}/>`;
  if (typeof valor === 'number') return `<c r="${ref}"${s}><v>${valor}</v></c>`;
  if (valor.data) {
    const [d, m, a] = valor.data.split('/').map(Number);
    const serial = (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
    return `<c r="${ref}"${s}><v>${serial}</v></c>`;
  }
  if (valor.hora) {
    const [h, mi, se] = valor.hora.split(':').map(Number);
    const fracao = ((h || 0) * 3600 + (mi || 0) * 60 + (se || 0)) / 86400;
    return `<c r="${ref}"${s}><v>${fracao}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escaparXml(valor)}</t></is></c>`;
}

function lerCelulas(corpo) {
  const celulas = [];
  const re = /<c\b[^>]*?\br="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g;
  let m;
  while ((m = re.exec(corpo))) {
    const estilo = /\bs="(\d+)"/.exec(m[0].slice(0, m[0].indexOf('>') + 1));
    // Células com fórmula (ex.: O = IFERROR(C,"")) não contam como dado digitado e nunca são sobrescritas.
    const temFormula = /<f[ >/]/.test(m[0]);
    const temValor = !temFormula && /<v>|<is>/.test(m[0]);
    celulas.push({ col: m[1], xml: m[0], estilo: estilo ? estilo[1] : null, temValor, temFormula });
  }
  return celulas;
}

function lerLinhas(xml) {
  const linhas = [];
  const re = /<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let m;
  while ((m = re.exec(xml))) {
    linhas.push({ r: Number(m[1]), inicio: m.index, fim: m.index + m[0].length, xml: m[0], corpo: m[2] || '' });
  }
  return linhas;
}

async function caminhoDaAba(zip, nomeAba) {
  const wb = await zip.file('xl/workbook.xml').async('string');
  const reSheet = /<sheet\b[^>]*>/g;
  let rid = null;
  let m;
  while ((m = reSheet.exec(wb))) {
    const nome = /\bname="([^"]*)"/.exec(m[0]);
    if (nome && nome[1] === escaparXml(nomeAba)) rid = /\br:id="([^"]*)"/.exec(m[0])[1];
  }
  if (!rid) throw new Error(`A aba "${nomeAba}" não foi encontrada na planilha.`);
  const rels = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${rid}"[^>]*>`).exec(rels)[0];
  const alvo = /\bTarget="([^"]*)"/.exec(rel)[1];
  return alvo.startsWith('/') ? alvo.slice(1) : 'xl/' + alvo;
}

function arquivoEmUso(caminho) {
  try {
    const fd = fs.openSync(caminho, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (e) {
    return e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES';
  }
}

// linhas: array de objetos { A: valor, B: valor, ... Y: valor }
async function inserirLinhas(caminho, nomeAba, linhas) {
  if (arquivoEmUso(caminho)) {
    throw new Error('A planilha está aberta no Excel. Feche a planilha e tente de novo.');
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(caminho));
  const caminhoAba = await caminhoDaAba(zip, nomeAba);
  let xml = await zip.file(caminhoAba).async('string');

  const existentes = lerLinhas(xml);
  let ultimaComDados = PRIMEIRA_LINHA_DADOS - 1;
  for (const l of existentes) {
    if (l.r < PRIMEIRA_LINHA_DADOS) continue;
    const temDados = lerCelulas(l.corpo).some((c) => c.temValor && colunaParaNumero(c.col) <= 25);
    if (temDados) ultimaComDados = Math.max(ultimaComDados, l.r);
  }
  const porNumero = new Map(existentes.map((l) => [l.r, l]));
  const modelo = porNumero.get(ultimaComDados);
  const estilosModelo = new Map(modelo ? lerCelulas(modelo.corpo).map((c) => [c.col, c.estilo]) : []);

  const numerosGravados = [];
  linhas.forEach((valores, i) => {
    const r = ultimaComDados + 1 + i;
    numerosGravados.push(r);
    const atual = porNumero.get(r);
    const celulasAtuais = atual ? lerCelulas(atual.corpo) : [];
    const estiloAtual = new Map(celulasAtuais.map((c) => [c.col, c.estilo]));
    const formulas = new Map(celulasAtuais.filter((c) => c.temFormula).map((c) => [c.col, c.xml]));
    const partes = COLUNAS.map((col) => {
      if (formulas.has(col)) return formulas.get(col);
      const estilo = estiloAtual.has(col) ? estiloAtual.get(col) : estilosModelo.get(col);
      return celulaXml(`${col}${r}`, estilo, valores[col]);
    });
    // Mantém células de colunas depois do Y (Z, AA...), se houver.
    for (const c of celulasAtuais) if (colunaParaNumero(c.col) > 25) partes.push(c.xml);

    if (atual) {
      const abertura = /^<row\b[^>]*?(?=\/?>)/.exec(atual.xml)[0];
      const novo = `${abertura}>${partes.join('')}</row>`;
      xml = xml.replace(atual.xml, () => novo);
    } else {
      const novo = `<row r="${r}" spans="1:25">${partes.join('')}</row>`;
      const depois = lerLinhas(xml).find((l) => l.r > r);
      if (depois) xml = xml.slice(0, depois.inicio) + novo + xml.slice(depois.inicio);
      else xml = xml.replace('</sheetData>', () => novo + '</sheetData>');
    }
  });

  // Estende o filtro e a área usada até a última linha gravada.
  const ultima = numerosGravados[numerosGravados.length - 1];
  let fimFiltroNovo = null;
  xml = xml.replace(/(<autoFilter\b[^>]*\bref="[A-Z]+\d+:[A-Z]+)(\d+)"/, (m, ini, fim) => {
    if (Number(fim) >= ultima) return m;
    fimFiltroNovo = ultima;
    return `${ini}${ultima}"`;
  });
  xml = xml.replace(/(<dimension\b[^>]*\bref="[A-Z]+\d+:[A-Z]+)(\d+)"/, (m, ini, fim) =>
    Number(fim) >= ultima ? m : `${ini}${ultima}"`);
  zip.file(caminhoAba, xml);

  let wbXml = await zip.file('xl/workbook.xml').async('string');
  if (fimFiltroNovo) {
    wbXml = wbXml.replace(
      new RegExp(`(<definedName\\b[^>]*name="_xlnm\\._FilterDatabase"[^>]*>[^<]*![^<]*?\\$)(\\d+)(</definedName>)`),
      (m, ini, fim, fecha) => `${ini}${fimFiltroNovo}${fecha}`
    );
  }
  // Pede ao Excel para recalcular os totais (SUBTOTAL) ao abrir.
  if (!/fullCalcOnLoad=/.test(wbXml)) wbXml = wbXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  zip.file('xl/workbook.xml', wbXml);

  const conteudo = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const temp = caminho + '.gravando';
  fs.writeFileSync(temp, conteudo);
  fs.renameSync(temp, caminho);
  return numerosGravados;
}

function fazerBackup(caminho, pastaBackups, manter = 30) {
  fs.mkdirSync(pastaBackups, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const destino = path.join(pastaBackups, `${carimbo} ${path.basename(caminho)}`);
  fs.copyFileSync(caminho, destino);
  const antigos = fs.readdirSync(pastaBackups).sort();
  for (const f of antigos.slice(0, Math.max(0, antigos.length - manter))) {
    fs.unlinkSync(path.join(pastaBackups, f));
  }
  return destino;
}

// Valor para escrever direto numa célula: datas e horas viram número (como o Excel guarda).
function valorParaCelula(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'object' && v.data) {
    const [d, m, a] = v.data.split('/').map(Number);
    return (Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  }
  if (typeof v === 'object' && v.hora) {
    const [h, mi, se] = v.hora.split(':').map(Number);
    return ((h || 0) * 3600 + (mi || 0) * 60 + (se || 0)) / 86400;
  }
  return v;
}

// Roda o excel-aberto.ps1 (planilha aberta no Excel). Devolve null se o arquivo não estiver
// aberto no Excel (está travado por outro motivo).
function rodarNoExcelAberto(caminho, nomeAba, dados, acao) {
  const arquivoDados = path.join(os.tmpdir(), `leitor-notas-${Date.now()}.json`);
  fs.writeFileSync(arquivoDados, JSON.stringify(dados));
  const script = path.join(__dirname, 'excel-aberto.ps1');
  return new Promise((ok, falha) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', script, '-Planilha', caminho, '-Aba', nomeAba, '-Dados', arquivoDados, '-Acao', acao],
      { windowsHide: true, maxBuffer: 1e6, timeout: 45000 }, (erro, saida) => {
        fs.rmSync(arquivoDados, { force: true });
        let r;
        try { r = JSON.parse(String(saida).trim().split(String.fromCharCode(10)).pop()); } catch { return falha(new Error('Não consegui mexer na planilha aberta no Excel.' + (erro ? ' ' + erro.message : ''))); }
        if (r.erro === 'NAO_ABERTA') return ok(null);
        if (r.erro) return falha(new Error(r.erro));
        ok(r);
      });
  });
}

// Planilha aberta no Excel: escreve pelo próprio Excel (as linhas aparecem na hora) e salva.
async function inserirComExcelAberto(caminho, nomeAba, linhas) {
  const r = await rodarNoExcelAberto(caminho, nomeAba, linhas.map((l) => COLUNAS.map((c) => valorParaCelula(l[c]))), 'inserir');
  if (!r) return null;
  return Array.isArray(r.linhas) ? r.linhas : [r.linhas];
}

// ---- Desfazer: apaga os valores das linhas inseridas (fórmulas ficam) ----
// conferencias: [{ linha, nf, cnpj }] só com dígitos. Se alguma linha não tiver mais aquela NF
// e aquele CNPJ do deslintamento, não apaga nada.

function desescaparXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

async function textosCompartilhados(zip) {
  const arq = zip.file('xl/sharedStrings.xml');
  if (!arq) return [];
  const xml = await arq.async('string');
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => desescaparXml(t[1])).join(''));
}

function textoDaCelula(xml, compartilhados) {
  const abertura = xml.slice(0, xml.indexOf('>') + 1);
  const tipo = (/\bt="(\w+)"/.exec(abertura) || [])[1];
  if (tipo === 'inlineStr') return desescaparXml([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''));
  const v = (/<v>([\s\S]*?)<\/v>/.exec(xml) || [])[1];
  if (v == null) return '';
  return tipo === 's' ? compartilhados[Number(v)] || '' : desescaparXml(v);
}

async function limparLinhas(caminho, nomeAba, conferencias) {
  if (arquivoEmUso(caminho)) throw new Error('A planilha está aberta no Excel. Feche a planilha e tente de novo.');
  const zip = await JSZip.loadAsync(fs.readFileSync(caminho));
  const caminhoAba = await caminhoDaAba(zip, nomeAba);
  let xml = await zip.file(caminhoAba).async('string');
  const compartilhados = await textosCompartilhados(zip);
  const porNumero = new Map(lerLinhas(xml).map((l) => [l.r, l]));
  const digitos = (s) => String(s || '').replace(/\D/g, '');

  for (const c of conferencias) {
    const linha = porNumero.get(c.linha);
    const celulas = linha ? lerCelulas(linha.corpo) : [];
    const valor = (col) => { const cel = celulas.find((x) => x.col === col); return cel ? digitos(textoDaCelula(cel.xml, compartilhados)) : ''; };
    if (valor('C') !== c.nf || valor('G') !== c.cnpj) {
      throw new Error(`A linha ${c.linha} da planilha não tem mais a NF ${c.nf} (alguém mexeu nela depois). Não apaguei nada; desfaça direto no Excel.`);
    }
  }
  for (const c of conferencias) {
    const linha = porNumero.get(c.linha);
    const partes = lerCelulas(linha.corpo).map((cel) => (colunaParaNumero(cel.col) <= 25 && !cel.temFormula
      ? `<c r="${cel.col}${c.linha}"${cel.estilo != null ? ` s="${cel.estilo}"` : ''}/>`
      : cel.xml));
    const abertura = /^<row\b[^>]*?(?=\/?>)/.exec(linha.xml)[0];
    const novo = `${abertura}>${partes.join('')}</row>`;
    xml = xml.replace(linha.xml, () => novo);
  }
  zip.file(caminhoAba, xml);
  let wbXml = await zip.file('xl/workbook.xml').async('string');
  if (!/fullCalcOnLoad=/.test(wbXml)) wbXml = wbXml.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"');
  zip.file('xl/workbook.xml', wbXml);
  const conteudo = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const temp = caminho + '.gravando';
  fs.writeFileSync(temp, conteudo);
  fs.renameSync(temp, caminho);
}

async function limparComExcelAberto(caminho, nomeAba, conferencias) {
  return rodarNoExcelAberto(caminho, nomeAba, conferencias, 'limpar');
}

module.exports = { inserirLinhas, inserirComExcelAberto, limparLinhas, limparComExcelAberto, fazerBackup, arquivoEmUso };
