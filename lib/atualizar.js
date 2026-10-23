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

// Tela cheia: atualização obrigatória. Atualiza sozinha (a menos que precise do zip novo) e só libera o
// programa quando a atualização termina de verdade; a barra é só visual (o servidor não informa o andamento).
function paginaAtualizacao(nova) {
  const zip = Boolean(nova.precisaZip);
  const novidades = (nova.novidades || []).slice(0, 6).map((n) => `<li>${esc(n)}</li>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Leitor de Notas · Atualização</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px;color:#e8efeb;font:15px/1.5 "Inter","Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden;
  background:radial-gradient(60% 50% at 20% 10%,rgba(52,179,106,.22),transparent 70%),radial-gradient(50% 50% at 90% 95%,rgba(34,165,89,.16),transparent 70%),#0b100d}
body::before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(70% 70% at 50% 45%,#000,transparent);-webkit-mask-image:radial-gradient(70% 70% at 50% 45%,#000,transparent)}
.cartao{position:relative;width:min(520px,100%);padding:38px 36px 30px;border-radius:24px;text-align:center;background:linear-gradient(180deg,rgba(255,255,255,.07),rgba(255,255,255,.025));border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 80px -30px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.08);backdrop-filter:blur(14px);animation:entra .6s cubic-bezier(.2,.7,.2,1) both}
@keyframes entra{from{opacity:0;transform:translateY(16px) scale(.98)}}
.logo{position:relative;width:76px;height:76px;margin:0 auto 22px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(145deg,#34b36a,#166534);box-shadow:inset 0 1px 0 rgba(255,255,255,.35),0 14px 34px -8px rgba(52,179,106,.6)}
.logo svg{width:38px;height:38px;stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.logo::after{content:"";position:absolute;inset:-8px;border-radius:28px;border:2px solid rgba(52,179,106,.45);animation:pulsa 2.2s ease-out infinite}
@keyframes pulsa{from{opacity:.9;transform:scale(.92)}to{opacity:0;transform:scale(1.25)}}
.selo{display:inline-flex;align-items:center;gap:7px;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#7ee2a8;background:rgba(52,179,106,.12);border:1px solid rgba(52,179,106,.3)}
.selo i{width:7px;height:7px;border-radius:50%;background:#34b36a;animation:pisca 1.2s infinite}
@keyframes pisca{50%{opacity:.25}}
h1{margin:16px 0 6px;font-size:26px;font-weight:700;letter-spacing:-.02em}
.sub{margin:0 auto;max-width:380px;color:#9eaba4;font-size:14.5px}
.versao{margin:18px auto 0;display:inline-flex;align-items:center;gap:10px;padding:8px 14px;border-radius:12px;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.07);font-size:13px;color:#9eaba4}
.versao b{color:#fff;font-weight:600}
.versao svg{width:16px;height:16px;stroke:#34b36a;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.progresso{margin-top:26px}
.trilho{height:10px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden;box-shadow:inset 0 1px 2px rgba(0,0,0,.4)}
.trilho i{display:block;height:100%;width:0;border-radius:99px;background:linear-gradient(90deg,#1f8a4a,#34b36a,#7ee2a8);background-size:200% 100%;animation:fluxo 1.6s linear infinite;transition:width .5s ease-out;box-shadow:0 0 18px rgba(52,179,106,.7)}
@keyframes fluxo{to{background-position:-200% 0}}
.linha{display:flex;justify-content:space-between;margin-top:10px;font-size:13px;color:#9eaba4}
.linha b{color:#e8efeb;font-weight:600;font-variant-numeric:tabular-nums}
.novidades{margin:24px 0 0;padding:14px 16px;border-radius:14px;text-align:left;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07)}
.novidades h2{margin:0 0 8px;font-size:11.5px;letter-spacing:.09em;text-transform:uppercase;color:#7ee2a8}
.novidades ul{margin:0;padding-left:18px;font-size:13.5px;color:#c9d4cf}.novidades li+li{margin-top:4px}
.aviso{margin-top:22px;font-size:12.5px;color:#6f7c75}
.erro .selo{color:#ff9b92;background:rgba(242,131,122,.1);border-color:rgba(242,131,122,.3)}
.erro .selo i{background:#f2837a;animation:none}
.erro .trilho i{background:#f2837a;box-shadow:0 0 18px rgba(242,131,122,.6);animation:none}
button{margin-top:20px;font:600 14px "Inter",system-ui,sans-serif;color:#fff;border:0;border-radius:12px;padding:11px 22px;cursor:pointer;background:linear-gradient(180deg,#1f8a4a,#166534);box-shadow:0 8px 20px -8px rgba(52,179,106,.7)}
button:hover{filter:brightness(1.1)}
.pronto .trilho i{animation:none}
</style></head><body>
<div class="cartao" id="cartao">
  <div class="logo"><svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg></div>
  <span class="selo"><i></i><span id="selo">${zip ? 'Atualização obrigatória' : 'Atualização obrigatória em andamento'}</span></span>
  <h1 id="titulo">${zip ? 'Nova versão disponível' : 'Atualizando o Leitor de Notas'}</h1>
  <p class="sub" id="msg">${zip ? `A versão ${esc(nova.versao)} precisa ser instalada pelo zip novo. Peça o arquivo para continuar usando o programa.` : 'Esta atualização é obrigatória. O programa será liberado assim que ela terminar.'}</p>
  <div class="versao"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>Versão <b>${esc(nova.versao)}</b></div>
  ${zip ? '' : `<div class="progresso"><div class="trilho"><i id="barra"></i></div>
    <div class="linha"><span id="etapa">Conectando...</span><b id="pct">0%</b></div></div>`}
  ${novidades ? `<div class="novidades"><h2>O que há de novo</h2><ul>${novidades}</ul></div>` : ''}
  <div class="aviso" id="aviso">${zip ? '' : 'Não feche a janela preta durante a atualização.'}</div>
</div>
${zip ? '' : `<script>
(async () => {
  const $ = (id) => document.getElementById(id);
  const etapas = ['Conectando ao servidor...', 'Baixando arquivos...', 'Verificando a integridade...', 'Guardando cópia de segurança...', 'Aplicando a nova versão...'];
  let pct = 0, terminou = false;
  const mostra = () => { $('barra').style.width = pct + '%'; $('pct').textContent = Math.floor(pct) + '%'; };
  // Andamento só visual: sobe rápido no começo, desacelera e para em 92% até a atualização acabar de verdade.
  const timer = setInterval(() => {
    if (terminou) return;
    pct += (92 - pct) * 0.045 + 0.15;
    if (pct > 92) pct = 92;
    $('etapa').textContent = etapas[Math.min(etapas.length - 1, Math.floor(pct / 19))];
    mostra();
  }, 400);
  const espera = (ms) => new Promise((ok) => setTimeout(ok, ms));
  try {
    const r = await fetch('/api/atualizar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Falha ao atualizar.');
    terminou = true; clearInterval(timer);
    pct = 100; mostra();
    $('cartao').classList.add('pronto');
    $('titulo').textContent = 'Tudo atualizado!';
    $('selo').textContent = 'Concluído';
    $('msg').textContent = 'Reabrindo o Leitor de Notas...';
    $('etapa').textContent = 'Reiniciando...';
    await espera(2500);
    for (let i = 0; i < 30; i++) {
      try { await fetch('/api/estado'); location.reload(); return; } catch { await espera(1000); }
    }
    $('msg').textContent = 'Atualizado. Feche a janela preta e abra o "Abrir Leitor de Notas.bat" de novo.';
  } catch (e) {
    terminou = true; clearInterval(timer);
    $('cartao').classList.add('erro');
    $('titulo').textContent = 'Não foi possível atualizar';
    $('selo').textContent = 'Atualização pendente';
    $('msg').textContent = e.message + ' Confira a internet e tente de novo.';
    $('etapa').textContent = 'Interrompido';
    $('aviso').innerHTML = '<button onclick="location.reload()">Tentar de novo</button>';
  }
})();
</script>`}
</body></html>`;
}

module.exports = { verificar, aplicar, lerVersaoLocal, paginaAtualizacao };
