// Avaliação rápida baseada no que o cliente FEZ: a cada 10 notas lançadas, olha o que ele mais corrigiu
// e em quais avisos mais clicou em "Já conferi", e monta de 2 a 3 perguntas sobre isso.
// Guarda só contagens (nome do campo / tipo do aviso), nunca dado de nota, empresa ou planilha.
const fs = require('fs');
const { camposCorrigidos } = require('./telemetria');

const A_CADA = 10; // notas lançadas entre uma avaliação e outra
const MINIMO = 3; // só pergunta do que aconteceu pelo menos 3 vezes nessas notas
const MAX_PERGUNTAS = 3;
const TROCA = 'Troca de deslintamento e licenciado (botão "Trocar")';
const NOME_AVISO = { saldo: 'saldo negativo', geral: '"Confira antes de inserir"' };

const nomeCampo = (coluna) => String(coluna).replace(/^[A-Z] · /, '');

function criarAvaliacao(arquivo) {
  let e = { notas: 0, campos: {}, avisos: {}, corrigidas: 0, ajustes: 0 };
  try { e = { ...e, ...JSON.parse(fs.readFileSync(arquivo, 'utf8')) }; } catch { /* começa do zero */ }
  const salvar = () => { try { fs.writeFileSync(arquivo, JSON.stringify(e)); } catch { /* não atrapalha o programa */ } };

  return {
    // Chamado a cada nota lançada: conta a nota e os campos que o auditor mudou.
    registrarNota(proposta, lancado) {
      e.notas += 1;
      const mudados = camposCorrigidos(proposta, lancado);
      if (mudados.length) { e.corrigidas += 1; e.ajustes += mudados.length; }
      for (const c of mudados) e.campos[c] = (e.campos[c] || 0) + 1;
      salvar();
    },
    // Chamado quando o auditor clica em "Já conferi" num aviso.
    registrarAviso(tipo) {
      if (!NOME_AVISO[tipo]) return;
      e.avisos[tipo] = (e.avisos[tipo] || 0) + 1;
      salvar();
    },
    // Resumo de tudo que foi corrigido (mesmo sem repetição): só nomes de campos e contagens.
    resumo() {
      if (!e.corrigidas) return `Nenhuma correção em ${e.notas} notas.`;
      const campos = Object.entries(e.campos).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${nomeCampo(c)} (${n})`).join(', ');
      return `Corrigiu algo em ${e.corrigidas} de ${e.notas} notas (${e.ajustes} ajustes no total). Campos: ${campos}.`;
    },
    // Perguntas para mostrar agora (ou null). Sem nada repetido, recomeça a contagem sem perguntar.
    // Nesse caso o resumo das correções fica em `resumoSemPergunta` para o servidor enviar sem abrir janela.
    resumoSemPergunta: null,
    perguntas() {
      this.resumoSemPergunta = null;
      if (e.notas < A_CADA) return null;
      const lista = [];
      for (const [campo, n] of Object.entries(e.campos)) {
        if (n < MINIMO) continue;
        if (campo === TROCA) {
          lista.push({ id: 'troca', n, texto: `Você trocou Deslintamento e Licenciado em ${n} das últimas ${e.notas} notas. A leitura está invertendo as empresas?`,
            opcoes: ['Sim, quase sempre', 'Às vezes', 'Não, foram casos específicos'] });
        } else {
          const nome = nomeCampo(campo);
          const cultivar = /Cultivar/i.test(nome);
          lista.push({ id: 'campo:' + nome, n, texto: `Nas últimas ${e.notas} notas você corrigiu ${cultivar ? 'a' : 'o campo'} ${nome} ${n} vezes. O que está acontecendo?`,
            opcoes: cultivar ? ['A leitura erra o nome', 'A cultivar não está na base', 'Outro motivo', 'Está tudo certo']
              : ['A leitura erra esse campo', 'Eu ajusto por regra da empresa', 'Outro motivo', 'Está tudo certo'] });
        }
      }
      for (const [tipo, n] of Object.entries(e.avisos)) {
        if (n < MINIMO) continue;
        lista.push({ id: 'aviso:' + tipo, n, texto: `Você clicou em "Já conferi" no aviso de ${NOME_AVISO[tipo]} ${n} vezes. Esse aviso está aparecendo à toa?`,
          opcoes: ['Sim, está atrapalhando', 'Às vezes', 'Não, ajuda a conferir'] });
      }
      if (!lista.length) { if (e.corrigidas) this.resumoSemPergunta = this.resumo(); this.zerar(); return null; }
      return { notas: e.notas, resumo: this.resumo(), perguntas: lista.sort((a, b) => b.n - a.n).slice(0, MAX_PERGUNTAS) };
    },
    // Respondeu ou pulou: começa a contar as próximas 10 notas.
    zerar() { e = { notas: 0, campos: {}, avisos: {}, corrigidas: 0, ajustes: 0 }; salvar(); },
  };
}

// Texto que vai para a aba Sugestões do painel.
function textoDasRespostas(pacote, respostas, comentario) {
  const linhas = [`Avaliação automática (últimas ${pacote.notas} notas)`];
  for (const p of pacote.perguntas) {
    const r = respostas[p.id];
    if (r) linhas.push(`• ${p.texto} → ${r}`);
  }
  if (pacote.resumo) linhas.push(`Resumo: ${pacote.resumo}`);
  if (comentario) linhas.push(`Comentário: ${comentario}`);
  return linhas.join('\n').slice(0, 3000);
}

module.exports = { criarAvaliacao, textoDasRespostas, A_CADA };
