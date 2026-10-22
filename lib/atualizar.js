// Atualização automática: confere no GitHub se tem versão nova e troca só os arquivos do programa.
// Nunca mexe em config.json, notas, planilha, backups, node/ nem no .bat (ele está rodando).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BRUTO = process.env.LEITOR_ATUALIZACAO_URL || 'https://raw.githubusercontent.com'; // trocável só para testar

function lerVersaoLocal(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, 'versao.json'), 'utf8'));
  } catch {
    return { versao: '0.0.0' };
  }
}

// "1.10.0" > "1.9.3"
function maisNova(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function baixar(url, tipo) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Não consegui baixar a atualização (erro ${r.status}).`);
  return tipo === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
}

// Só pode gravar dentro da pasta do programa, em arquivos do próprio programa.
function caminhoPermitido(raiz, rel) {
  const destino = path.resolve(raiz, rel);
  const relativo = path.relative(raiz, destino);
  if (!relativo || relativo.startsWith('..') || path.isAbsolute(relativo)) return null;
  const primeiro = relativo.split(path.sep)[0].toLowerCase();
  if (['config.json', 'node', 'node_modules', '.leituras'].includes(primeiro) || /\.(bat|cmd|exe)$/i.test(relativo)) return null;
  return destino;
}

let ultimaConsulta = { quando: 0, resultado: null };

async function verificar(raiz) {
  const local = lerVersaoLocal(raiz);
  if (!local.repo) return { atual: local.versao };
  // Consulta no máximo uma vez por hora (o programa fica aberto o dia todo).
  if (ultimaConsulta.resultado && Date.now() - ultimaConsulta.quando < 3600 * 1000) return ultimaConsulta.resultado;
  let remota;
  try {
    remota = await baixar(`${BRUTO}/${local.repo}/main/versao.json?t=${Date.now()}`, 'json');
  } catch {
    return { atual: local.versao }; // sem internet: tenta de novo na próxima vez
  }
  const resultado = { atual: local.versao };
  if (maisNova(remota.versao, local.versao)) {
    resultado.nova = { versao: remota.versao, novidades: remota.novidades || [], precisaZip: Boolean(remota.precisaZip) };
  }
  ultimaConsulta = { quando: Date.now(), resultado };
  return resultado;
}

async function aplicar(raiz, pastaBackups) {
  const local = lerVersaoLocal(raiz);
  if (!local.repo) throw new Error('Este programa não está ligado a nenhum lugar de atualização.');
  const remota = await baixar(`${BRUTO}/${local.repo}/main/versao.json?t=${Date.now()}`, 'json');
  if (!maisNova(remota.versao, local.versao)) throw new Error('O programa já está na versão mais nova.');
  if (remota.precisaZip) throw new Error('Esta versão precisa ser instalada pelo zip novo.');

  // 1) Baixa tudo e confere cada arquivo antes de trocar qualquer coisa.
  const novos = [];
  for (const { arquivo, sha256 } of remota.arquivos || []) {
    const destino = caminhoPermitido(raiz, arquivo);
    if (!destino) continue;
    const conteudo = await baixar(`${BRUTO}/${local.repo}/v${remota.versao}/${arquivo}`);
    if (crypto.createHash('sha256').update(conteudo).digest('hex') !== sha256) {
      throw new Error('A atualização veio incompleta. Tente de novo mais tarde.');
    }
    novos.push({ arquivo, destino, conteudo });
  }
  if (!novos.length) throw new Error('A atualização veio vazia.');

  // 2) Guarda a versão atual dos arquivos que vão mudar.
  const pastaVelha = path.join(pastaBackups, `Programa versão ${local.versao}`);
  for (const { arquivo, destino } of novos) {
    if (!fs.existsSync(destino)) continue;
    const copia = path.join(pastaVelha, arquivo);
    fs.mkdirSync(path.dirname(copia), { recursive: true });
    fs.copyFileSync(destino, copia);
  }

  // 3) Troca: grava ao lado e renomeia por cima (não deixa arquivo pela metade).
  for (const { destino, conteudo } of novos) {
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino + '.novo', conteudo);
    fs.renameSync(destino + '.novo', destino);
  }
  fs.writeFileSync(path.join(raiz, 'versao.json'), JSON.stringify({ versao: remota.versao, repo: local.repo }, null, 2));
  ultimaConsulta = { quando: 0, resultado: null };
  return { versao: remota.versao };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Tela cheia: atualiza sozinha (a menos que precise do zip novo) e recarrega quando o programa reabrir.
function paginaAtualizacao(nova) {
  const titulo = nova.precisaZip ? 'Atualização obrigatória' : 'Atualizando o Leitor de Notas...';
  const texto = nova.precisaZip
    ? `A versão ${esc(nova.versao)} precisa ser instalada pelo zip novo. Peça o arquivo para continuar.`
    : `Versão ${esc(nova.versao)} é obrigatória para continuar. Não feche a janela preta.`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Leitor de Notas</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1b1b1f;color:#f2f2f2;font-family:system-ui,sans-serif}
main{max-width:480px;padding:32px;text-align:center}
.icone{font-size:64px}
h1{margin:16px 0 8px;font-size:26px}
p{font-size:18px;line-height:1.5;color:#c9c9d1}
</style></head><body><main>
<div class="icone">⬇️</div><h1>${titulo}</h1><p id="msg">${texto}</p>
</main></body></html>
${nova.precisaZip ? '' : `<script>
(async () => {
  const msg = document.getElementById('msg');
  try {
    const r = await fetch('/api/atualizar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) throw new Error((await r.json()).erro || 'Falha ao atualizar.');
    msg.textContent = 'Atualizado! Abrindo de novo...';
    await new Promise((ok) => setTimeout(ok, 2500));
    for (let i = 0; i < 30; i++) {
      try { await fetch('/api/estado'); location.reload(); return; } catch { await new Promise((ok) => setTimeout(ok, 1000)); }
    }
    msg.textContent = 'Atualizado. Feche a janela preta e abra o "Abrir Leitor de Notas.bat" de novo.';
  } catch (e) {
    msg.textContent = e.message + ' Tente abrir de novo mais tarde.';
  }
})();
</script>`}`;
}

module.exports = { verificar, aplicar, lerVersaoLocal, paginaAtualizacao };
