// Aprende com as correções do auditor, mas SÓ com a permissão dele.
// 1) A cada nota lançada, compara o que o programa propôs com o que foi lançado e anota as trocas.
// 2) Quando a MESMA troca acontece em 2 notas diferentes, sem nenhuma nota em que ele deixou como estava,
//    o programa pergunta na tela: "Quer que eu faça isso sozinho nas próximas?".
// 3) Só depois do "Sim" a regra passa a valer. Ela aparece marcada na nota e pode ser desfeita ali mesmo.
// 4) Se o auditor desfizer a regra 2 vezes seguidas, ela é pausada sozinha.
// Quantidade, número, data, chave e observações NUNCA são aprendidos. Nada disso sai do computador.
const fs = require('fs');
const crypto = require('crypto');
const { soDigitos, chaveValida, lerChave } = require('./chave');

const MINIMO_NOTAS = 2; // a mesma troca em quantas notas diferentes para sugerir
const PAUSA_DEPOIS_DE = 2; // desfeita quantas vezes seguidas para pausar sozinha
const MAX_SITUACOES = 1000;
const UM_DIA = 24 * 3600 * 1000;

const norm = (s) => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const cnpj14 = (s) => { const d = soDigitos(s); return d.length === 14 ? d : ''; };

const TIPOS_VOLUME = { entrada: 'entrada', saida: 'saída', semDeslintar: 'saída sem deslintar' };
function tipoDoItem(it) {
  const tem = (v) => String(v ?? '').trim() !== '';
  const tipos = Object.keys(TIPOS_VOLUME).filter((k) => tem(it[k]));
  return tipos.length === 1 ? tipos[0] : '';
}
// Um só valor para todos os itens (sem contar os que só têm quebra), ou '' se misturado.
function unico(lista) {
  const s = [...new Set(lista.filter(Boolean))];
  return s.length === 1 ? s[0] : '';
}

// ---- As "situações" de uma nota: cada lugar onde uma troca pode ser aprendida ----
// de = o que o programa propôs (antes das regras), para = o que o auditor lançou.

function situacoes(proposta, lancado, ctx) {
  const lista = [];
  const add = (tipo, contexto, de, para, extra = {}) => {
    if (!contexto || !norm(de)) return;
    // Tipo do volume e troca guardam códigos (saida, CNPJ): não passam para maiúsculas.
    const n = tipo === 'tipo' || tipo === 'troca' ? (v) => String(v ?? '').trim() : norm;
    lista.push({ tipo, ctx: contexto, de: n(de), para: n(para), ...extra });
  };
  const itensP = proposta.itens || [];
  const itensL = lancado.itens || [];

  // Cultivar: a nota tem uma cultivar só (lida pela IA) e foi lançada com uma cultivar só.
  const lida = unico((ctx.cultivaresLidas || []).map(norm));
  const lancada = unico(itensL.map((i) => norm(i.cultivar)));
  if (ctx.emitente && lida && lancada) add('cultivar', ctx.emitente, lida, lancada, { nome: ctx.emitenteNome });

  // Cliente de cada cultivar que aparece na proposta e no lançamento.
  for (const cult of new Set(itensP.map((i) => norm(i.cultivar)).filter(Boolean))) {
    const p = unico(itensP.filter((i) => norm(i.cultivar) === cult).map((i) => norm(i.cliente)));
    const daCultivar = itensL.filter((i) => norm(i.cultivar) === cult);
    const l = unico(daCultivar.map((i) => norm(i.cliente)));
    if (p && l && daCultivar.length) add('cliente', cult, p, l);
  }

  // Nome e cidade de cada empresa, pelo CNPJ (vale mesmo se as empresas foram trocadas de quadro).
  const porCnpj = (f) => {
    const m = new Map();
    for (const parte of [f.deslint, f.licenc]) if (parte && cnpj14(parte.cnpj)) m.set(cnpj14(parte.cnpj), parte);
    return m;
  };
  const pP = porCnpj(proposta);
  const pL = porCnpj(lancado);
  for (const [cnpj, p] of pP) {
    const l = pL.get(cnpj);
    if (!l) continue;
    add('razao', cnpj, p.razao, l.razao, { nome: norm(p.razao) });
    if (norm(p.cidade) && norm(l.cidade)) add('cidade', cnpj, `${norm(p.cidade)}/${norm(p.uf)}`, `${norm(l.cidade)}/${norm(l.uf)}`, { nome: norm(l.razao) });
  }

  // Quem é a deslintadora entre as duas empresas.
  const dP = cnpj14(proposta.deslint && proposta.deslint.cnpj);
  const lP = cnpj14(proposta.licenc && proposta.licenc.cnpj);
  const dL = cnpj14(lancado.deslint && lancado.deslint.cnpj);
  const lL = cnpj14(lancado.licenc && lancado.licenc.cnpj);
  if (dP && lP && dP !== lP && [dL, lL].sort().join() === [dP, lP].sort().join()) {
    const nomes = { [dP]: norm(proposta.deslint.razao), [lP]: norm(proposta.licenc.razao) };
    add('troca', [dP, lP].sort().join('|'), dP, dL, { nomes });
  }

  // Tipo do volume (entrada / saída / sem deslintar) para essas empresas com essa natureza da operação.
  const tp = unico(itensP.map(tipoDoItem));
  const tl = unico(itensL.map(tipoDoItem));
  if (ctx.emitente && ctx.destinatario && ctx.natureza && tp && tl) {
    add('tipo', [ctx.emitente, ctx.destinatario, ctx.natureza].join('|'), tp, tl, { nome: `${ctx.emitenteNome} → ${ctx.destinatarioNome}`, natureza: ctx.natureza });
  }
  return lista;
}

// ---- Textos para a tela ----

const listaNotas = (notas) => {
  const nfs = [...new Set(notas.map((n) => n.nf).filter(Boolean))];
  if (!nfs.length) return '';
  return 'NF ' + (nfs.length === 1 ? nfs[0] : nfs.slice(0, -1).join(', ') + ' e ' + nfs[nfs.length - 1]);
};
const rotuloTipo = (t) => TIPOS_VOLUME[t] || t;
const cnpjBonito = (d) => (d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : d);

function descrever(r) {
  const nomeTroca = (cnpj) => (r.nomes && r.nomes[cnpj]) || cnpjBonito(cnpj);
  switch (r.tipo) {
    case 'cultivar': return { titulo: `Cultivar ${r.de} → ${r.para}`, onde: `notas de ${r.nome || cnpjBonito(r.ctx)}` };
    case 'cliente': return { titulo: `Cliente da cultivar ${r.ctx}: ${r.de} → ${r.para}`, onde: 'todas as notas dessa cultivar' };
    case 'razao': return { titulo: `Nome da empresa: ${r.de} → ${r.para}`, onde: `CNPJ ${cnpjBonito(r.ctx)}` };
    case 'cidade': return { titulo: `Cidade: ${r.de} → ${r.para}`, onde: `${r.nome || 'empresa'} (CNPJ ${cnpjBonito(r.ctx)})` };
    case 'troca': return { titulo: `A deslintadora é ${nomeTroca(r.para)}`, onde: `notas entre ${r.ctx.split('|').map(nomeTroca).join(' e ')}` };
    case 'tipo': return { titulo: `Lançar como ${rotuloTipo(r.para)} (e não ${rotuloTipo(r.de)})`, onde: `${r.nome}, natureza "${r.natureza}"` };
    default: return { titulo: `${r.de} → ${r.para}`, onde: '' };
  }
}

function textoSugestao(s) {
  const notas = listaNotas(s.notas);
  const n = new Set(s.notas.map((x) => x.nf)).size;
  const nomeTroca = (cnpj) => (s.nomes && s.nomes[cnpj]) || cnpjBonito(cnpj);
  switch (s.tipo) {
    case 'cultivar': return `Você trocou a cultivar ${s.de} por ${s.para} em ${n} notas de ${s.nome || cnpjBonito(s.ctx)} (${notas}).`;
    case 'cliente': return `Você trocou o cliente da cultivar ${s.ctx} de ${s.de} para ${s.para} em ${n} notas (${notas}).`;
    case 'razao': return `Você corrigiu o nome da empresa de CNPJ ${cnpjBonito(s.ctx)} de "${s.de}" para "${s.para}" em ${n} notas (${notas}).`;
    case 'cidade': return `Você corrigiu a cidade de ${s.nome || 'uma empresa'} de ${s.de} para ${s.para} em ${n} notas (${notas}).`;
    case 'troca': return `Nas notas entre ${s.ctx.split('|').map(nomeTroca).join(' e ')}, você trocou deslintamento e licenciado ${n} vezes (${notas}): a deslintadora é ${nomeTroca(s.para)}.`;
    case 'tipo': return `Nas notas de ${s.nome} com natureza "${s.natureza}", você lançou como ${rotuloTipo(s.para)} em vez de ${rotuloTipo(s.de)} em ${n} notas (${notas}).`;
    default: return `Você trocou ${s.de} por ${s.para} em ${n} notas (${notas}).`;
  }
}

// ---- Aplicar as regras aprovadas ----

// No que a IA leu (antes de montar o formulário): só a cultivar, porque a cultivar desconhecida
// seria descartada na montagem. Devolve uma cópia dos dados e as regras usadas.
function aplicarNosDados(dados, ctx, regras, normalizar) {
  const copia = JSON.parse(JSON.stringify(dados));
  const usadas = [];
  for (const r of regras.filter((x) => x.ativa && x.tipo === 'cultivar' && x.ctx === ctx.emitente)) {
    let usou = false;
    for (const it of copia.itens || []) {
      if (norm(normalizar(it.cultivar)) === r.de) { it.cultivar = r.para; usou = true; }
    }
    if (usou) usadas.push(r);
  }
  return { dados: copia, usadas };
}

// No formulário montado. Muda o formulário e devolve, para cada regra usada, os campos mudados
// (com o valor de antes), para a tela poder desfazer só naquela nota.
function aplicarNoFormulario(f, ctx, regras, usadasNosDados = []) {
  const aplicadas = [];
  const ativas = regras.filter((x) => x.ativa);
  const registrar = (r, campos, campo) => { if (campos.length) aplicadas.push({ regra: r, campos, campo }); };

  for (const r of usadasNosDados) {
    const campos = [];
    (f.itens || []).forEach((it, i) => { if (norm(it.cultivar) === r.para) campos.push({ c: `itens.${i}.cultivar`, antes: r.de }); });
    registrar(r, campos, 'itens');
  }
  // Troca de quadros primeiro: as outras regras procuram as empresas pelo CNPJ.
  for (const r of ativas.filter((x) => x.tipo === 'troca')) {
    const d = cnpj14(f.deslint && f.deslint.cnpj);
    const l = cnpj14(f.licenc && f.licenc.cnpj);
    if (!d || !l || [d, l].sort().join('|') !== r.ctx || d !== r.de) continue;
    const campos = [];
    for (const k of ['razao', 'cnpj', 'cidade', 'uf']) campos.push({ c: `deslint.${k}`, antes: f.deslint[k] }, { c: `licenc.${k}`, antes: f.licenc[k] });
    [f.deslint, f.licenc] = [f.licenc, f.deslint];
    registrar(r, campos, 'deslint');
  }
  for (const r of ativas.filter((x) => x.tipo === 'tipo')) {
    if ([ctx.emitente, ctx.destinatario, ctx.natureza].join('|') !== r.ctx) continue;
    const itens = (f.itens || []).filter((it) => tipoDoItem(it));
    if (!itens.length || unico(itens.map(tipoDoItem)) !== r.de) continue;
    const campos = [];
    f.itens.forEach((it, i) => {
      if (tipoDoItem(it) !== r.de) return;
      campos.push({ c: `itens.${i}.${r.de}`, antes: it[r.de] }, { c: `itens.${i}.${r.para}`, antes: it[r.para] });
      it[r.para] = it[r.de];
      it[r.de] = '';
    });
    registrar(r, campos, 'itens');
  }
  for (const r of ativas.filter((x) => x.tipo === 'cliente')) {
    const campos = [];
    (f.itens || []).forEach((it, i) => {
      if (norm(it.cultivar) === r.ctx && norm(it.cliente) === r.de) { campos.push({ c: `itens.${i}.cliente`, antes: it.cliente }); it.cliente = r.para; }
    });
    registrar(r, campos, 'itens');
  }
  for (const r of ativas.filter((x) => x.tipo === 'razao' || x.tipo === 'cidade')) {
    for (const lado of ['deslint', 'licenc']) {
      const p = f[lado];
      if (!p || cnpj14(p.cnpj) !== r.ctx) continue;
      if (r.tipo === 'razao' && norm(p.razao) === r.de) {
        registrar(r, [{ c: `${lado}.razao`, antes: p.razao }], lado);
        p.razao = r.para;
      }
      if (r.tipo === 'cidade' && `${norm(p.cidade)}/${norm(p.uf)}` === r.de) {
        registrar(r, [{ c: `${lado}.cidade`, antes: p.cidade }, { c: `${lado}.uf`, antes: p.uf }], lado);
        [p.cidade, p.uf] = r.para.split('/');
      }
    }
  }
  return aplicadas;
}

// ---- O arquivo com o que foi aprendido ----

function criarAprendizado(arquivo, { agora = () => Date.now() } = {}) {
  const vazio = () => ({ versao: 1, situacoes: {}, regras: [], recusadas: [], adiadas: {}, avisos: [] });
  const ler = () => {
    try { return { ...vazio(), ...JSON.parse(fs.readFileSync(arquivo, 'utf8')) }; } catch { return vazio(); }
  };
  const salvar = (b) => {
    // Guarda só as situações mais recentes, para o arquivo não crescer sem parar.
    const chaves = Object.keys(b.situacoes);
    if (chaves.length > MAX_SITUACOES) {
      chaves.sort((a, c) => (b.situacoes[a].ultima || '').localeCompare(b.situacoes[c].ultima || ''));
      for (const k of chaves.slice(0, chaves.length - MAX_SITUACOES)) delete b.situacoes[k];
    }
    fs.writeFileSync(arquivo + '.novo', JSON.stringify(b, null, 1));
    fs.renameSync(arquivo + '.novo', arquivo);
  };
  const chaveDe = (tipo, ctx, de) => JSON.stringify([tipo, ctx, de]);

  // Contexto que a leitura guarda e a tela devolve na hora de inserir.
  function contextoDaLeitura(dados, normalizar) {
    const chave = soDigitos(dados.chave_acesso);
    const emitente = chaveValida(chave) ? lerChave(chave).cnpjEmitente : cnpj14(dados.emitente && dados.emitente.cnpj);
    return {
      emitente: cnpj14(emitente),
      emitenteNome: norm(dados.emitente && dados.emitente.razao_social),
      destinatario: cnpj14(dados.destinatario && dados.destinatario.cnpj),
      destinatarioNome: norm(dados.destinatario && dados.destinatario.razao_social),
      natureza: norm(dados.natureza_operacao),
      cultivaresLidas: [...new Set((dados.itens || []).map((it) => norm(normalizar(it.cultivar))).filter(Boolean))],
    };
  }

  // Lê a nota com as regras aprovadas. propor = (dados) => proporFormulario(dados, ref).
  function proporComRegras(dados, normalizar, propor) {
    const b = ler();
    const ctx = contextoDaLeitura(dados, normalizar);
    const nosDados = aplicarNosDados(dados, ctx, b.regras, normalizar);
    const r = propor(nosDados.dados);
    const aplicadas = aplicarNoFormulario(r.formulario, ctx, b.regras, nosDados.usadas);
    for (const a of aplicadas) {
      const d = descrever(a.regra);
      r.avisos.push({
        nivel: 'info',
        campo: a.campo,
        regra: { id: a.regra.id, campos: a.campos },
        texto: `Corrigido pela regra que você aprovou: ${d.titulo}.`,
      });
    }
    r.contexto = { ...ctx, aplicadas: aplicadas.map((a) => ({ id: a.regra.id, tipo: a.regra.tipo, ctx: a.regra.ctx, de: a.regra.de, para: a.regra.para })) };
    return r;
  }

  // Depois de lançar uma nota. id = id da inserção (para desfazer), nf = nº da nota.
  function observar({ proposta, lancado, contexto, id, nf }) {
    if (!proposta || !lancado || !contexto) return;
    const b = ler();
    const quando = new Date(agora()).toISOString();
    const nota = { id, nf: String(nf || ''), quando };
    const aplicadas = contexto.aplicadas || [];
    for (const s of situacoes(proposta, lancado, contexto)) {
      // Regra que foi usada nesta nota: a proposta já veio com o valor da regra.
      const usada = aplicadas.find((a) => a.tipo === s.tipo && a.ctx === s.ctx && (s.tipo === 'cultivar' ? a.de === s.de : a.para === s.de));
      const regra = usada && b.regras.find((r) => r.id === usada.id);
      let de = s.de;
      if (regra) {
        de = regra.de;
        regra.eventos = [...(regra.eventos || []), { id, ev: s.para === regra.para ? 'uso' : 'desfeita', quando }].slice(-30);
        const seguidas = [...regra.eventos].reverse().findIndex((e) => e.ev !== 'desfeita');
        const desfeitas = seguidas === -1 ? regra.eventos.length : seguidas;
        if (regra.ativa && desfeitas >= PAUSA_DEPOIS_DE) {
          regra.ativa = false;
          regra.pausadaSozinha = true;
          b.avisos.push({ id: crypto.randomBytes(5).toString('hex'), texto: `Pausei a regra "${descrever(regra).titulo}" porque você desfez ela ${desfeitas} vezes seguidas. Dá para ligar de novo em Configurações.` });
        }
        if (s.para === regra.para) continue; // usou a regra: não é observação nova
      }
      const k = chaveDe(s.tipo, s.ctx, de);
      const sit = b.situacoes[k] || (b.situacoes[k] = { tipo: s.tipo, ctx: s.ctx, de, trocas: {}, mantidas: [] });
      for (const extra of ['nome', 'nomes', 'natureza']) if (s[extra]) sit[extra] = s[extra];
      sit.ultima = quando;
      if (s.para === de) sit.mantidas.push(nota);
      else (sit.trocas[s.para] ||= []).push(nota);
    }
    salvar(b);
  }

  // Desfez a inserção na planilha: esquece o que foi aprendido com ela.
  function esquecerInsercao(id) {
    if (!id) return;
    const b = ler();
    for (const sit of Object.values(b.situacoes)) {
      sit.mantidas = sit.mantidas.filter((n) => n.id !== id);
      for (const p of Object.keys(sit.trocas)) {
        sit.trocas[p] = sit.trocas[p].filter((n) => n.id !== id);
        if (!sit.trocas[p].length) delete sit.trocas[p];
      }
    }
    for (const r of b.regras) r.eventos = (r.eventos || []).filter((e) => e.id !== id);
    salvar(b);
  }

  // Sugestões prontas para perguntar.
  function sugestoes(b = ler()) {
    const lista = [];
    for (const [k, sit] of Object.entries(b.situacoes)) {
      if (sit.mantidas.length) continue; // deixou como estava em alguma nota: não é regra
      const paras = Object.keys(sit.trocas);
      if (paras.length !== 1) continue; // trocou para coisas diferentes: não é regra
      const notas = sit.trocas[paras[0]];
      if (new Set(notas.map((n) => n.nf || n.id)).size < MINIMO_NOTAS) continue;
      if (b.recusadas.includes(k) || b.regras.some((r) => r.chave === k)) continue;
      if (b.adiadas[k] && b.adiadas[k] > agora()) continue;
      const s = { chave: k, tipo: sit.tipo, ctx: sit.ctx, de: sit.de, para: paras[0], notas, nome: sit.nome, nomes: sit.nomes, natureza: sit.natureza };
      lista.push({ ...s, texto: textoSugestao(s), ...descrever(s) });
    }
    return lista;
  }

  function responder(chave, resposta) {
    const b = ler();
    const s = sugestoes(b).find((x) => x.chave === chave);
    if (!s) throw new Error('Essa sugestão não vale mais (talvez você já tenha respondido).');
    if (resposta === 'sim') {
      b.regras.push({
        id: crypto.randomBytes(5).toString('hex'), chave, tipo: s.tipo, ctx: s.ctx, de: s.de, para: s.para,
        nome: s.nome, nomes: s.nomes, natureza: s.natureza, criada: new Date(agora()).toISOString(), ativa: true, eventos: [],
      });
    } else if (resposta === 'nao') b.recusadas.push(chave);
    else if (resposta === 'depois') b.adiadas[chave] = agora() + UM_DIA;
    else throw new Error('Resposta inválida.');
    salvar(b);
  }

  function mudarRegra(id, acao) {
    const b = ler();
    const r = b.regras.find((x) => x.id === id);
    if (!r) throw new Error('Regra não encontrada.');
    if (acao === 'apagar') {
      b.regras = b.regras.filter((x) => x.id !== id);
      // Apagou: não pergunta de novo a mesma coisa (só se voltar a acontecer do zero).
      delete b.situacoes[r.chave];
    } else if (acao === 'pausar') r.ativa = false;
    else if (acao === 'ligar') { r.ativa = true; r.pausadaSozinha = false; r.eventos = []; }
    else throw new Error('Ação inválida.');
    salvar(b);
  }

  function avisoVisto(id) {
    const b = ler();
    b.avisos = b.avisos.filter((a) => a.id !== id);
    salvar(b);
  }

  function resumo() {
    const b = ler();
    return {
      sugestoes: sugestoes(b),
      avisos: b.avisos,
      regras: b.regras.map((r) => ({
        id: r.id, tipo: r.tipo, ativa: r.ativa, pausadaSozinha: !!r.pausadaSozinha, criada: r.criada,
        usos: (r.eventos || []).filter((e) => e.ev === 'uso').length, ...descrever(r),
      })),
    };
  }

  return { proporComRegras, observar, esquecerInsercao, responder, mudarRegra, avisoVisto, resumo };
}

module.exports = { criarAprendizado, situacoes, MINIMO_NOTAS };
