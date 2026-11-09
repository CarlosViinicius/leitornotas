// Relatório em Excel para mandar ao cliente (obtentora: TMG, IMA, BAYER/TMG...).
// Aba "Resumo": por licenciado + deslintadora + cultivar, o movimento do período e o saldo acumulado.
// Aba "Notas": cada linha da planilha que entrou no período, para conferência.
const ExcelJS = require('exceljs');
const { agrupar } = require('./conferencias');

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const COR = {
  verde: 'FF166534', verdeClaro: 'FFE8F5EC', cinza: 'FF66736B', borda: 'FFD9E0DC', sutil: 'FFF6F8F7',
  vermelho: 'FFB42318', vermelhoFundo: 'FFFDECEB', amarelo: 'FF7A5B00', amareloFundo: 'FFFFF7D6',
};
const br = (iso) => (iso ? iso.split('-').reverse().join('/') : '');

// "2026-10" -> { de: '2026-10-01', ate: '2026-10-31', nome: 'outubro de 2026' }. Vazio = tudo.
function periodoDoMes(mes) {
  const m = String(mes || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return { de: '', ate: '', nome: 'todo o período da planilha' };
  const ano = Number(m[1]);
  const n = Number(m[2]);
  const ultimo = new Date(Date.UTC(ano, n, 0)).getUTCDate();
  return { de: `${m[1]}-${m[2]}-01`, ate: `${m[1]}-${m[2]}-${String(ultimo).padStart(2, '0')}`, nome: `${MESES[n - 1]} de ${ano}` };
}

// Junta o movimento do período com o saldo acumulado até o fim dele.
function montarDados({ movimentos, cliente, mes, limiteQuebra = 3 }) {
  const periodo = periodoDoMes(mes);
  const doCliente = (movimentos || []).filter((mv) => !cliente || String(mv.cliente || '').toUpperCase() === String(cliente).toUpperCase());
  const noPeriodo = (mv) => !periodo.ate || (mv.data && mv.data >= periodo.de && mv.data <= periodo.ate);
  // Linha sem data entra no acumulado (não dá para saber o mês), mas não no movimento do mês.
  const ateOFim = (mv) => !periodo.ate || !mv.data || mv.data <= periodo.ate;
  const linhasPeriodo = doCliente.filter(noPeriodo);
  const mov = new Map(agrupar(linhasPeriodo).map((g) => [g.chave, g]));
  const acum = new Map(agrupar(doCliente.filter(ateOFim)).map((g) => [g.chave, g]));
  const grupos = [];
  for (const [chave, a] of acum) {
    const p = mov.get(chave);
    const temMovimento = p && (p.entrada || p.saida || p.semDeslintar || p.quebra);
    if (!temMovimento && Math.abs(a.naDeslintadora) < 0.5) continue; // sem movimento e já fechado: não interessa
    grupos.push({
      licenciado: a.licenciado, licencDoc: a.licencDoc, deslintadora: a.deslintadora, deslintDoc: a.deslintDoc,
      cultivar: a.cultivar, safras: a.safras,
      entrada: p ? p.entrada : 0, saida: p ? p.saida : 0, semDeslintar: p ? p.semDeslintar : 0, quebra: p ? p.quebra : 0,
      quebraPctAcum: a.quebraPct, naDeslintadora: a.naDeslintadora, voltouMais: a.voltouMais,
      quebraAlta: a.quebraPct != null && a.quebraPct > limiteQuebra,
    });
  }
  const gravidade = (g) => (g.voltouMais ? 2 : 0) + (g.quebraAlta ? 1 : 0);
  grupos.sort((x, y) => gravidade(y) - gravidade(x) || x.licenciado.localeCompare(y.licenciado) || x.cultivar.localeCompare(y.cultivar));
  return {
    periodo, grupos,
    linhas: linhasPeriodo.sort((a, b) => (a.data || '').localeCompare(b.data || '') || a.linha - b.linha),
    semData: doCliente.filter((mv) => !mv.data).length,
  };
}

const doc = (d) => (d && d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : d && d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : '');

async function gerarRelatorio({ movimentos, cliente, mes, limiteQuebra = 3, auditor = '', aba = '' }) {
  const { periodo, grupos, linhas, semData } = montarDados({ movimentos, cliente, mes, limiteQuebra });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Leitor de Notas';
  wb.created = new Date();
  const agora = new Date();
  const geradoEm = `${String(agora.getDate()).padStart(2, '0')}/${String(agora.getMonth() + 1).padStart(2, '0')}/${agora.getFullYear()} às ${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;
  const borda = { style: 'thin', color: { argb: COR.borda } };
  const bordas = { top: borda, bottom: borda, left: borda, right: borda };
  const KG = '#,##0';
  const PCT = '0.0%';

  // ---- Resumo ----
  const ws = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 7, showGridLines: false }] });
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  ws.headerFooter.oddFooter = '&L&8Leitor de Notas&R&8Página &P de &N';
  ws.columns = [
    { width: 34 }, { width: 19 }, { width: 30 }, { width: 19 }, { width: 15 }, { width: 9 },
    { width: 13 }, { width: 13 }, { width: 13 }, { width: 12 }, { width: 11 }, { width: 15 }, { width: 27 },
  ];
  ws.mergeCells('A1:M1');
  ws.getCell('A1').value = `Relatório de deslintamento${cliente ? ` · ${cliente}` : ''}`;
  ws.getCell('A1').font = { size: 16, bold: true, color: { argb: COR.verde } };
  ws.mergeCells('A2:M2');
  ws.getCell('A2').value = `Período: ${periodo.nome}${periodo.de ? ` (${br(periodo.de)} a ${br(periodo.ate)})` : ''}   ·   Auditor: ${auditor || '—'}   ·   Gerado em ${geradoEm}`;
  ws.getCell('A2').font = { size: 10, color: { argb: COR.cinza } };

  // Totais do período
  const soma = (k) => grupos.reduce((t, g) => t + g[k], 0);
  const tot = { entrada: soma('entrada'), saida: soma('saida'), semDeslintar: soma('semDeslintar'), quebra: soma('quebra'), naDeslintadora: soma('naDeslintadora') };
  const atencao = grupos.filter((g) => g.voltouMais || g.quebraAlta).length;
  const kpis = [
    ['Entrou no período', tot.entrada, KG], ['Voltou deslintado', tot.saida, KG], ['Voltou sem deslintar', tot.semDeslintar, KG],
    ['Quebra no período', tot.quebra, KG], ['Na deslintadora (acumulado)', tot.naDeslintadora, KG], ['Precisam de atenção', atencao, '0'],
  ];
  const colKpi = ['A', 'C', 'E', 'G', 'I', 'L'];
  kpis.forEach(([rotulo, valor, fmt], i) => {
    const c = colKpi[i];
    const rot = ws.getCell(`${c}4`);
    rot.value = rotulo;
    rot.font = { size: 9, color: { argb: COR.cinza } };
    const v = ws.getCell(`${c}5`);
    v.value = valor;
    v.numFmt = fmt === KG ? `${KG} "kg"` : fmt;
    v.font = { size: 14, bold: true, color: { argb: i === 5 && valor ? COR.vermelho : 'FF17201B' } };
    v.alignment = { horizontal: 'left' };
  });

  const cab = ['Licenciado', 'CNPJ/CPF licenciado', 'Deslintadora', 'CNPJ deslintadora', 'Cultivar', 'Safra',
    'Entrada (kg)', 'Saída (kg)', 'Sem deslintar (kg)', 'Quebra (kg)', 'Quebra % (acum.)', 'Na deslintadora (kg, acum.)', 'Situação'];
  const linhaCab = ws.getRow(7);
  linhaCab.values = cab;
  linhaCab.height = 30;
  linhaCab.eachCell((cel) => {
    cel.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.verde } };
    cel.alignment = { vertical: 'middle', wrapText: true };
    cel.border = bordas;
  });
  let r = 8;
  for (const g of grupos) {
    const situacao = [g.voltouMais ? 'Voltou mais do que entrou' : '', g.quebraAlta ? `Quebra acima de ${String(limiteQuebra).replace('.', ',')}%` : ''].filter(Boolean).join('; ') || 'OK';
    const row = ws.getRow(r++);
    row.values = [g.licenciado, doc(g.licencDoc), g.deslintadora, doc(g.deslintDoc), g.cultivar, g.safras.join(', '),
      g.entrada, g.saida, g.semDeslintar, g.quebra, g.quebraPctAcum == null ? null : g.quebraPctAcum / 100, g.naDeslintadora, situacao];
    row.eachCell({ includeEmpty: true }, (cel, n) => {
      cel.border = bordas;
      cel.alignment = { vertical: 'top', wrapText: n <= 4 || n === 13 };
      if (n >= 7 && n <= 10) cel.numFmt = KG;
      if (n === 11) cel.numFmt = PCT;
      if (n === 12) { cel.numFmt = `${KG};[Red]-${KG}`; cel.font = { bold: true }; }
    });
    const sit = row.getCell(13);
    if (g.voltouMais) { sit.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.vermelhoFundo } }; sit.font = { bold: true, color: { argb: COR.vermelho } }; }
    else if (g.quebraAlta) { sit.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.amareloFundo } }; sit.font = { bold: true, color: { argb: COR.amarelo } }; }
    else sit.font = { color: { argb: COR.cinza } };
  }
  if (!grupos.length) {
    ws.mergeCells(`A${r}:M${r}`);
    ws.getCell(`A${r}`).value = 'Nenhum movimento neste período.';
    ws.getCell(`A${r}`).font = { italic: true, color: { argb: COR.cinza } };
    r++;
  } else {
    const t = ws.getRow(r++);
    t.values = ['Total', '', '', '', '', '', tot.entrada, tot.saida, tot.semDeslintar, tot.quebra, null, tot.naDeslintadora, ''];
    t.eachCell({ includeEmpty: true }, (cel, n) => {
      cel.font = { bold: true };
      cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.verdeClaro } };
      cel.border = bordas;
      if (n >= 7 && n <= 12) cel.numFmt = n === 12 ? `${KG};[Red]-${KG}` : KG;
    });
    ws.autoFilter = { from: 'A7', to: `M${r - 2}` };
  }
  r++;
  const notas = [
    'Entrada, saída, sem deslintar e quebra: só as notas com data dentro do período.',
    'Quebra % (acum.) e Na deslintadora (acum.): tudo desde o início da planilha até o fim do período. Na deslintadora = entrada − saída − sem deslintar − quebra.',
    `"Voltou mais do que entrou": o que voltou passa do que entrou (com 0,5% de tolerância). Pode faltar lançar alguma remessa.`,
    semData ? `${semData} linha(s) da planilha sem data: entram no acumulado, mas não no movimento do período.` : '',
    `Fonte: planilha${aba ? `, aba ${aba}` : ''}.`,
  ].filter(Boolean);
  for (const n of notas) {
    ws.mergeCells(`A${r}:M${r}`);
    const c = ws.getCell(`A${r++}`);
    c.value = n;
    c.font = { size: 9, color: { argb: COR.cinza } };
  }

  // ---- Notas ----
  const wn = wb.addWorksheet('Notas', { views: [{ state: 'frozen', ySplit: 1 }] });
  wn.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 };
  wn.columns = [
    { header: 'NF', width: 11 }, { header: 'Data', width: 12 }, { header: 'Linha na planilha', width: 10 },
    { header: 'Licenciado', width: 32 }, { header: 'Deslintadora', width: 30 }, { header: 'Cultivar', width: 15 }, { header: 'Safra', width: 9 },
    { header: 'Tipo', width: 14 }, { header: 'Entrada (kg)', width: 13 }, { header: 'Saída (kg)', width: 13 }, { header: 'Sem deslintar (kg)', width: 13 }, { header: 'Quebra (kg)', width: 12 },
  ];
  wn.getRow(1).height = 30;
  wn.getRow(1).eachCell((cel) => {
    cel.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cel.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COR.verde } };
    cel.alignment = { vertical: 'middle', wrapText: true };
  });
  const tipo = (mv) => [mv.entrada && 'Entrada', mv.saida && 'Saída', mv.semDeslintar && 'Sem deslintar', mv.quebra && 'Quebra'].filter(Boolean).join(' + ');
  for (const mv of linhas) {
    const row = wn.addRow([mv.nf ? Number(mv.nf) || mv.nf : '', br(mv.data), mv.linha, mv.licenc, mv.deslint, mv.cultivar, mv.safra, tipo(mv),
      mv.entrada || null, mv.saida || null, mv.semDeslintar || null, mv.quebra || null]);
    row.eachCell({ includeEmpty: true }, (cel, n) => { cel.border = bordas; if (n >= 9) cel.numFmt = KG; });
  }
  if (linhas.length) wn.autoFilter = { from: 'A1', to: `L${linhas.length + 1}` };
  else wn.addRow(['Nenhuma nota neste período.']);

  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), periodo, grupos: grupos.length, notas: linhas.length };
}

module.exports = { gerarRelatorio, montarDados, periodoDoMes };
