// Código de liberação: só quem tem a chave privada (o desenvolvedor) consegue gerar um código válido.
// O programa guarda apenas a chave PÚBLICA, que só serve para conferir. Cada código vale por um tempo (dias) a partir
// de quando é digitado, só pode ser digitado dentro de um prazo depois de gerado e nunca é aceito duas vezes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHAVE_PUBLICA = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAd3L8bRuacrD4yl6looP0ut1NNdWVTy4+tH8yeyzxCiY=
-----END PUBLIC KEY-----`;

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const VALIDADE_PARA_DIGITAR_MS = 15 * 24 * 3600 * 1000; // o código precisa ser usado em até 15 dias depois de gerado
const ARQUIVO = 'liberacao.json';

// Senha numérica de liberação: só o "hash" dela fica aqui (scrypt, lento de propósito), nunca a senha.
const SENHA = { salt: 'bbd178b67dd0b9c9a62f69bd17af7ff1', hash: '6fc634d504e636f6fa16bd33401c7680795e1c976770f2572b647e42ce9d252f' };

// Senha anterior (teste grátis): já foi usada e expirou. Quem digitar vê a mensagem de expirada.
const SENHA_ANTIGA = { salt: '4a51b4b7c7f98d41b508bb338080a2cd', hash: '2a16806af75415d66be993c16a61933bacc55bc2310158dd6a96ab2d15a3c503' };
// Quem entrou com a senha anterior (liberação sem "v") perde o acesso neste momento: 29/10/2026 23:59 (Brasília).
const FIM_TESTE = Date.UTC(2026, 9, 30, 2, 59, 0);

// Próximo dia 27 às 15:00 (horário de Brasília, UTC-3) depois de "agora": quando o prazo reinicia.
function proximoReinicio(agora = Date.now()) {
  const d = new Date(agora);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 27, 18, 0, 0);
  if (t <= agora) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 27, 18, 0, 0);
  return t;
}

function senhaConfere(digitos, alvo = SENHA) {
  try {
    const calc = crypto.scryptSync(digitos, Buffer.from(alvo.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
    return crypto.timingSafeEqual(calc, Buffer.from(alvo.hash, 'hex'));
  } catch {
    return false;
  }
}

function deBase32(texto) {
  let bits = 0;
  let valor = 0;
  const saida = [];
  for (const c of texto) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) return null;
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      saida.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(saida);
}

// Retorna { ok: true, id, dias, emitido } ou { ok: false, erro }.
function conferirCodigo(codigo) {
  const limpo = String(codigo || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes = deBase32(limpo);
  if (!bytes || bytes.length < 11 + 64) return { ok: false, erro: 'Código incompleto. Cole o código inteiro.' };
  const dados = bytes.subarray(0, 11);
  const assinatura = bytes.subarray(11, 11 + 64);
  let valido = false;
  try {
    valido = crypto.verify(null, dados, crypto.createPublicKey(CHAVE_PUBLICA), assinatura);
  } catch {}
  if (!valido || dados[0] !== 1) return { ok: false, erro: 'Código inválido.' };
  const id = dados.subarray(1, 5).toString('hex');
  const emitido = dados.readUInt32BE(5) * 1000;
  const dias = dados.readUInt16BE(9);
  if (Date.now() - emitido > VALIDADE_PARA_DIGITAR_MS) return { ok: false, erro: 'Este código expirou. Peça um novo.' };
  return { ok: true, id, dias, emitido };
}

function lerLiberacao(raiz) {
  try {
    return JSON.parse(fs.readFileSync(path.join(raiz, ARQUIVO), 'utf8'));
  } catch {
    return { ate: 0, usados: [] };
  }
}

// Data (ms) até quando o programa está liberado por código; 0 se não está.
function liberadoAte(raiz) {
  const l = lerLiberacao(raiz);
  let ate = Number(l.ate);
  // Liberação da senha anterior (sem "v", vencendo num dia 27 às 18:00 UTC): termina junto com o teste grátis.
  const d = new Date(ate);
  const ehSenhaAntiga = !l.v && d.getUTCDate() === 27 && d.getUTCHours() === 18 && d.getUTCMinutes() === 0;
  if (ehSenhaAntiga) ate = Math.min(ate, FIM_TESTE);
  return ate > Date.now() ? ate : 0;
}

function usarCodigo(raiz, codigo) {
  // Senha numérica: libera até o próximo dia 27 às 15:00 e pode ser usada todo mês.
  const digitos = String(codigo || '').replace(/[^0-9]/g, '');
  if (digitos.length >= 6 && digitos.length === String(codigo || '').replace(/[\s.-]/g, '').length) {
    if (senhaConfere(digitos, SENHA_ANTIGA)) return { ok: false, erro: 'Este código já foi utilizado e expirou.' };
    if (!senhaConfere(digitos)) return { ok: false, erro: 'Senha incorreta.' };
    const ate = proximoReinicio();
    const l = lerLiberacao(raiz);
    fs.writeFileSync(path.join(raiz, ARQUIVO), JSON.stringify({ v: 2, ate, usados: Array.isArray(l.usados) ? l.usados : [] }, null, 2));
    return { ok: true, ate };
  }
  const r = conferirCodigo(codigo);
  if (!r.ok) return r;
  const l = lerLiberacao(raiz);
  const usados = Array.isArray(l.usados) ? l.usados : [];
  if (usados.includes(r.id)) return { ok: false, erro: 'Este código já foi usado.' };
  const ate = Date.now() + r.dias * 24 * 3600 * 1000;
  fs.writeFileSync(path.join(raiz, ARQUIVO), JSON.stringify({ v: 2, ate, usados: [...usados, r.id] }, null, 2));
  return { ok: true, ate, dias: r.dias };
}

module.exports = { conferirCodigo, usarCodigo, liberadoAte, proximoReinicio };
