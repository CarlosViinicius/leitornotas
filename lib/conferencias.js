// Conferências de auditoria que usam a planilha inteira:
// - Saldo por licenciado + deslintadora + cultivar (entrou, voltou, quebra, o que ainda está na deslintadora).
// - Nota de retorno: a nota de remessa citada está na planilha? Com este retorno, volta mais do que entrou?
// - Quebra técnica acima do limite.
// - Conferências baratas pela chave de acesso: data (mês/ano), UF do emitente, CNPJ/CPF válidos.
const { soDigitos, lerChave, CODIGO_UF } = require('./chave');
const { cnpjValido } = require('./exato');

const LIMITE_QUEBRA_PADRAO = 3; // %
const kg = (n) => Number(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const t = String(v ?? '').trim();
  if (!t) return 0;
  const n = Number(/,/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t);
  return Number.isFinite(n) ? n : 0;
};
const nomeNucleo = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  .replace(/\b(LTDA|EIRELI|S\/?A|ME|EPP)\b/g, '').replace(/[^A-Z0-9]/g, '');
// Identifica a empresa pelo CNPJ/CPF; sem documento, pelo nome.
const idEmpresa = (doc, nome) => {
  const d = soDigitos(doc);
  return d.length === 14 || d.length === 11 ? d : nomeNucleo(nome) ? 'N:' + nomeNucleo(nome) : '';
};
const cultivarNorm = (c) => String(c || '').toUpperCase().replace(/\s+/g, '');
// O par de empresas vai em ordem fixa: se alguma linha foi lançada com os quadros trocados
// (deslintamento no lugar do licenciado), ela continua somando no mesmo saldo.
const chaveGrupo = (idA, idB, cultivar) => [[idA, idB].sort().join('+'), cultivar].join('|');

function cpfValido(c) {
  const d = soDigitos(c);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const dv = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

// ---- Saldo (painel) ----

// Agrupa uma lista de movimentos (linhas da planilha) por par de empresas + cultivar.
function agrupar(movimentos) {
  const grupos = new Map();
  const contar = (m, nome) => m.set(nome, (m.get(nome) || 0) + 1);
  for (const mv of movimentos || []) {
    const lic = idEmpresa(mv.licencCnpj, mv.licenc);
    const des = idEmpresa(mv.deslintCnpj, mv.deslint);
    const cult = cultivarNorm(mv.cultivar) || '(SEM CULTIVAR)';
    const k = chaveGrupo(lic, des, cult);
    if (!grupos.has(k)) {
      grupos.set(k, { chave: k, licencDoc: soDigitos(mv.licencCnpj), deslintDoc: soDigitos(mv.deslintCnpj), cultivar: cult,
        nomesLicenc: new Map(), nomesDeslint: new Map(), safras: new Set(), entrada: 0, saida: 0, semDeslintar: 0, quebra: 0, notas: [] });
    }
    const g = grupos.get(k);
    contar(g.nomesLicenc, mv.licenc || '(sem nome)');
    contar(g.nomesDeslint, mv.deslint || '(sem nome)');
    if (mv.safra) g.safras.add(mv.safra);
    for (const t of ['entrada', 'saida', 'semDeslintar', 'quebra']) g[t] += num(mv[t]);
    g.notas.push({ nf: mv.nf, linha: mv.linha, data: mv.data || '', safra: mv.safra || '', entrada: num(mv.entrada), saida: num(mv.saida), semDeslintar: num(mv.semDeslintar), quebra: num(mv.quebra) });
  }
  const maisUsado = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return [...grupos.values()].map((g) => {
    const voltou = g.saida + g.semDeslintar + g.quebra;
    return {
      chave: g.chave, cultivar: g.cultivar, licenciado: maisUsado(g.nomesLicenc), licencDoc: g.licencDoc,
      deslintadora: maisUsado(g.nomesDeslint), deslintDoc: g.deslintDoc, safras: [...g.safras].sort(),
      entrada: g.entrada, saida: g.saida, semDeslintar: g.semDeslintar, quebra: g.quebra,
      naDeslintadora: g.entrada - voltou,
      quebraPct: g.entrada > 0 ? (g.quebra / g.entrada) * 100 : null,
      voltouMais: voltou > g.entrada + Math.max(1, g.entrada * 0.005),
      notas: g.notas.sort((a, b) => a.linha - b.linha),
    };
  });
}

// Quando voltou mais do que entrou, procura a causa provável e marca as notas suspeitas.
// Só aponta o que dá para provar pelos números da planilha; nunca "corrige" nada.
function diagnosticar(grupos) {
  const voltouNota = (n) => n.saida + n.semDeslintar + n.quebra;
  for (const g of grupos) {
    g.dicas = [];
    if (!g.voltouMais) continue;
    const voltou = g.saida + g.semDeslintar + g.quebra;
    const sobra = voltou - g.entrada; // quanto voltou a mais
    const tol = Math.max(1, sobra * 0.005);
    const marcar = (nfs) => { for (const n of g.notas) if (nfs.includes(n)) n.suspeita = true; };
    const retornos = g.notas.filter((n) => voltouNota(n) > 0);

    // a) Mesma NF com o mesmo volume lançada mais de uma vez.
    const vistas = new Map();
    for (const n of retornos) {
      if (!n.nf) continue;
      const k = n.nf + '|' + voltouNota(n).toFixed(3);
      vistas.set(k, [...(vistas.get(k) || []), n]);
    }
    for (const lista of vistas.values()) {
      if (lista.length < 2) continue;
      marcar(lista.slice(1));
      g.dicas.push(`A NF ${lista[0].nf} (${kg(voltouNota(lista[0]))} kg) aparece ${lista.length} vezes, nas linhas ${lista.map((n) => n.linha).join(', ')}. Pode ter sido lançada em duplicidade.`);
    }

    // b) Uma nota (ou duas) de retorno que somam justamente o que passou: falta a remessa dela.
    const jaDuplicada = g.dicas.length > 0;
    const unica = jaDuplicada ? [] : retornos.filter((n) => Math.abs(voltouNota(n) - sobra) <= tol);
    if (unica.length && unica.length <= 3) {
      marcar(unica);
      g.dicas.push(`O que passou (${kg(sobra)} kg) é exatamente o volume ${unica.length === 1 ? 'da NF' : 'das NFs'} ${unica.map((n) => `${n.nf || '?'} (linha ${n.linha})`).join(', ')}. Provavelmente falta lançar a remessa dela, ou ela foi lançada duas vezes.`);
    } else if (!jaDuplicada && retornos.length <= 60) {
      let achou = null;
      for (let i = 0; i < retornos.length && !achou; i++) {
        for (let j = i + 1; j < retornos.length; j++) {
          if (Math.abs(voltouNota(retornos[i]) + voltouNota(retornos[j]) - sobra) <= tol) { achou = [retornos[i], retornos[j]]; break; }
        }
      }
      if (achou) {
        marcar(achou);
        g.dicas.push(`O que passou (${kg(sobra)} kg) é a soma das NFs ${achou.map((n) => `${n.nf || '?'} (linha ${n.linha})`).join(' e ')}. Pode faltar a remessa delas.`);
      }
    }

    // c) Em outro grupo sobra o mesmo volume: a remessa pode ter sido lançada com cultivar ou empresa diferente.
    for (const o of grupos) {
      if (o === g || o.naDeslintadora <= 0 || Math.abs(o.naDeslintadora - sobra) > tol) continue;
      const mesmoLic = o.licencDoc && o.licencDoc === g.licencDoc;
      g.dicas.push(`Em ${o.licenciado} (${o.deslintadora}), cultivar ${o.cultivar}, ainda estão ${kg(o.naDeslintadora)} kg na deslintadora, o mesmo valor que passou aqui. ${mesmoLic ? 'A remessa pode ter sido lançada com a cultivar errada.' : 'A remessa pode ter sido lançada com outra empresa ou cultivar.'}`);
    }

    // d) Casa remessas e retornos de peso igual (o caso comum: 50.000 kg que foi e voltou). Se só sobra UM retorno
    //    contra remessas que ainda não voltaram, é nele que está a diferença.
    if (!g.dicas.length) {
      const entradas = g.notas.filter((n) => n.entrada > 0).map((n) => ({ n, v: n.entrada }));
      const sobraRet = [];
      for (const r of retornos) {
        const i = entradas.findIndex((e) => Math.abs(e.v - voltouNota(r)) <= 0.5);
        if (i >= 0) entradas.splice(i, 1); else sobraRet.push(r);
      }
      if (sobraRet.length === 1 && entradas.length >= 1) {
        const r = sobraRet[0];
        const faltam = entradas.reduce((t, e) => t + e.v, 0);
        if (voltouNota(r) > faltam) {
          marcar([r]);
          g.dicas.push(`Casando as notas de mesmo peso, só sobra a NF ${r.nf || '?'} (linha ${r.linha}), um retorno de ${kg(voltouNota(r))} kg para ${entradas.length === 1 ? 'a remessa' : 'as remessas'} de ${kg(faltam)} kg (NF ${entradas.map((e) => e.n.nf || '?').join(', ')}). Os ${kg(voltouNota(r) - faltam)} kg a mais estão nessa nota: falta lançar a remessa deles, ou o peso dela está errado.`);
        }
      }
    }

    if (!g.dicas.length) g.dicas.push(`Voltou ${kg(sobra)} kg a mais do que entrou. Confira se falta lançar alguma remessa deste grupo ou se alguma quantidade está errada.`);
  }
  return grupos;
}

// ---- Conferências da nota que está na tela ----

// Números das notas citadas pela nota (fora ela mesma): o que a IA achou + chaves de outras notas no texto do PDF.
function notasCitadas(dados, numeroProprio) {
  const nums = new Set();
  for (const r of dados.notas_referenciadas || []) {
    const n = Number(soDigitos(r && (r.numero ?? r)));
    if (n > 0 && n < 1e9) nums.add(n);
    const ch = soDigitos(r && r.chave);
    if (ch.length === 44) nums.add(lerChave(ch).numero);
  }
  for (const ch of dados.chaves_citadas || []) nums.add(lerChave(ch).numero);
  nums.delete(Number(numeroProprio));
  nums.delete(0);
  return [...nums];
}

function conferirNota({ dados = {}, formulario: f, ref, limiteQuebra = LIMITE_QUEBRA_PADRAO, duplicada = false }) {
  const avisos = [];
  const incertos = [];
  const lim = Number(limiteQuebra) > 0 ? Number(limiteQuebra) : LIMITE_QUEBRA_PADRAO;

  // 1) Pela chave de acesso (só quando ela confere).
  if (f.chaveOk && f.chave) {
    const info = lerChave(f.chave);
    const d = String(f.data || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (d && (Number(d[2]) !== info.mes || Number(d[3]) !== info.ano)) {
      avisos.push({ nivel: 'alerta', texto: `A data da nota (${f.data}) não bate com o mês da chave de acesso (${String(info.mes).padStart(2, '0')}/${info.ano}). A data pode ter sido lida errada. Confira.` });
      incertos.push('data_emissao');
    }
    const ufChave = Object.keys(CODIGO_UF).find((uf) => CODIGO_UF[uf] === info.uf);
    const emitente = [f.deslint, f.licenc].find((p) => p && soDigitos(p.cnpj) === info.cnpjEmitente);
    const ufLida = String((emitente && emitente.uf) || '').trim().toUpperCase();
    if (ufChave && ufLida && ufLida !== ufChave) {
      avisos.push({ nivel: 'alerta', texto: `A UF do emitente (${ufLida}) não bate com a chave de acesso, que é de ${ufChave}. Confira a UF de ${emitente.razao || 'quem emitiu a nota'}.` });
      incertos.push('emitente');
    }
  }

  // 2) CNPJ/CPF das duas empresas.
  for (const [lado, nome] of [['deslint', 'deslintamento'], ['licenc', 'licenciado']]) {
    const d = soDigitos(f[lado] && f[lado].cnpj);
    if (!d) continue;
    const problema = d.length === 14 ? (cnpjValido(d) ? '' : 'não é um CNPJ válido')
      : d.length === 11 ? (cpfValido(d) ? '' : 'não é um CPF válido')
        : `tem ${d.length} números (CNPJ tem 14 e CPF tem 11)`;
    if (problema) {
      avisos.push({ nivel: 'alerta', texto: `O CNPJ do ${nome} (${f[lado].cnpj}) ${problema}: algum número foi lido errado. Confira na nota.` });
      incertos.push(lado === 'deslint' ? 'destinatario' : 'emitente');
    }
  }

  if (duplicada || !ref) return { avisos, incertos };

  // 3) Nota de retorno (saída, sem deslintar ou quebra).
  const itens = f.itens || [];
  const ehRetorno = itens.some((it) => num(it.saida) || num(it.semDeslintar) || num(it.quebra));
  const licId = idEmpresa(f.licenc && f.licenc.cnpj, f.licenc && f.licenc.razao);
  const desId = idEmpresa(f.deslint && f.deslint.cnpj, f.deslint && f.deslint.razao);

  if (ehRetorno) {
    // 3a) Notas de remessa citadas: estão na planilha?
    const docs = [soDigitos(f.deslint && f.deslint.cnpj), soDigitos(f.licenc && f.licenc.cnpj)].filter(Boolean);
    for (const n of notasCitadas(dados, f.nf)) {
      const linhas = (ref.nfsLancadas.get(String(n)) || []).filter((l) => {
        const cl = l.cnpjs.filter(Boolean);
        return !cl.length || !docs.length || cl.some((c) => docs.includes(c));
      }).map((l) => l.linha);
      avisos.push(linhas.length
        ? { nivel: 'info', campo: 'nota', texto: `A nota cita a NF ${n}, que está lançada na planilha (linha ${linhas.join(', ')}).` }
        : { nivel: 'alerta', texto: `A nota cita a NF ${n} (remessa), mas ela não está lançada na planilha para essas empresas. Confira se a remessa já foi lançada.` });
    }

    // 3b) Com este retorno, volta mais do que entrou?
    if (licId && desId) {
      const porCultivar = new Map();
      for (const it of itens) {
        const c = cultivarNorm(it.cultivar);
        if (!c) continue;
        const v = porCultivar.get(c) || { entrada: 0, voltou: 0 };
        v.entrada += num(it.entrada);
        v.voltou += num(it.saida) + num(it.semDeslintar) + num(it.quebra);
        porCultivar.set(c, v);
      }
      for (const [c, nota] of porCultivar) {
        if (!nota.voltou) continue;
        let entrada = nota.entrada;
        let voltou = nota.voltou;
        for (const mv of ref.movimentos || []) {
          if (chaveGrupo(idEmpresa(mv.licencCnpj, mv.licenc), idEmpresa(mv.deslintCnpj, mv.deslint), cultivarNorm(mv.cultivar)) !== chaveGrupo(licId, desId, c)) continue;
          entrada += num(mv.entrada);
          voltou += num(mv.saida) + num(mv.semDeslintar) + num(mv.quebra);
        }
        if (voltou > entrada + Math.max(1, entrada * 0.005)) {
          avisos.push({ nivel: 'alerta', texto: entrada > 0
            ? `Com esta nota, voltam ${kg(voltou)} kg de ${c} para ${f.licenc.razao}, mas só entraram ${kg(entrada)} kg em ${f.deslint.razao} pela planilha. Confira se falta lançar alguma remessa ou se a quantidade está certa.`
            : `Não há nenhuma entrada de ${c} de ${f.licenc.razao} em ${f.deslint.razao} na planilha, mas esta nota é um retorno de ${kg(nota.voltou)} kg. Confira se a remessa já foi lançada.` });
        }
      }
    }
  }

  // 4) Quebra técnica desta nota acima do limite (comparada ao volume que voltou junto, da mesma cultivar).
  const porCult = new Map();
  for (const it of itens) {
    const c = cultivarNorm(it.cultivar) || '-';
    const v = porCult.get(c) || { quebra: 0, total: 0 };
    v.quebra += num(it.quebra);
    v.total += num(it.saida) + num(it.semDeslintar) + num(it.quebra);
    porCult.set(c, v);
  }
  for (const [c, v] of porCult) {
    if (v.quebra > 0 && v.total > v.quebra) {
      const pct = (v.quebra / v.total) * 100;
      if (pct > lim) {
        avisos.push({ nivel: 'alerta', texto: `A quebra técnica desta nota (${kg(v.quebra)} kg${c !== '-' ? ` de ${c}` : ''}) é ${pct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% do volume, acima do limite de ${lim.toLocaleString('pt-BR')}%. Confira.` });
      }
    }
  }
  return { avisos, incertos };
}

// Filtros do painel: safra (texto da coluna Q, "__sem" = sem safra) e "até o mês" (AAAA-MM).
// Um mês sozinho não fecha conta (a remessa pode ser de um mês e o retorno de outro), por isso é sempre "até".
function filtrarMovimentos(movimentos, { safra = '', ate = '' } = {}) {
  return (movimentos || []).filter((m) => {
    if (safra && (safra === '__sem' ? m.safra : m.safra !== safra)) return false;
    if (ate && m.data && m.data.slice(0, 7) > ate) return false;
    return true;
  });
}

const saldoPorGrupo = (ref, filtros) => diagnosticar(agrupar(filtrarMovimentos(ref.movimentos, filtros)));

module.exports = { saldoPorGrupo, filtrarMovimentos, diagnosticar, agrupar, idEmpresa, conferirNota, notasCitadas, cpfValido, LIMITE_QUEBRA_PADRAO };
