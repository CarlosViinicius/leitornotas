// Bloqueio temporário: confere no GitHub o arquivo bloqueio.json. Se "bloqueado" for true,
// o programa mostra a mensagem em vez de abrir. Para liberar, é só trocar para false lá.
// Sem internet ou com erro, vale o último estado que deu para conferir (guardado em .leituras).
const fs = require('fs');
const path = require('path');

const BRUTO = process.env.LEITOR_ATUALIZACAO_URL || 'https://raw.githubusercontent.com';
const ARQ_ESTADO = (raiz) => path.join(raiz, '.leituras', '.estado');
let cache = { quando: 0, resultado: { bloqueado: false } };

function repoDe(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, 'versao.json'), 'utf8')).repo;
  } catch {
    return null;
  }
}

async function verificarBloqueio(raiz) {
  const repo = repoDe(raiz);
  if (!repo) return { bloqueado: false };
  if (Date.now() - cache.quando < 30 * 1000) return cache.resultado;
  let resultado = { bloqueado: false };
  try {
    resultado = JSON.parse(fs.readFileSync(ARQ_ESTADO(raiz), 'utf8'));
  } catch {}
  try {
    const r = await fetch(`${BRUTO}/${repo}/main/bloqueio.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const dados = await r.json();
      resultado = dados.bloqueado === true ? { bloqueado: true, titulo: dados.titulo, mensagem: dados.mensagem } : { bloqueado: false };
      try {
        fs.mkdirSync(path.dirname(ARQ_ESTADO(raiz)), { recursive: true });
        fs.writeFileSync(ARQ_ESTADO(raiz), JSON.stringify(resultado));
      } catch {}
    }
  } catch {}
  cache = { quando: Date.now(), resultado };
  return resultado;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function paginaBloqueio(b) {
  const titulo = b.titulo || 'Acesso bloqueado temporariamente';
  const mensagem = b.mensagem || 'Este programa está bloqueado até você pedir desculpa.';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Leitor de Notas</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1b1b1f;color:#f2f2f2;font-family:system-ui,sans-serif}
main{max-width:480px;padding:32px;text-align:center}
.icone{font-size:64px}
h1{margin:16px 0 8px;font-size:26px}
p{font-size:18px;line-height:1.5;color:#c9c9d1}
small{color:#8a8a94}
</style></head><body><main>
<div class="icone">🔒</div><h1>${esc(titulo)}</h1><p>${esc(mensagem)}</p>
<small>Assim que o pedido de desculpas chegar, o acesso volta sozinho.</small>
</main></body></html>`;
}

module.exports = { verificarBloqueio, paginaBloqueio };
