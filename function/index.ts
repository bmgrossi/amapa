// "Lei ou lenda?" — Liderança em Foco · Grupo Amapá — API de votação ao vivo
// Mesmo molde das palestras LGPD: o gateway do Supabase bloqueia HTML em *.supabase.co,
// então as páginas moram no GitHub Pages e esta função é só API.
// Tabelas ll_estado e ll_voto têm RLS ligada sem policies: só o service role acessa.
// Votação anônima: o celular guarda um identificador aleatório só para não votar duas vezes.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const REST = `${SUPABASE_URL}/rest/v1`;

const EVENTO = 'amapa';
const CHAVE_ADMIN = 'COLOQUE_A_CHAVE_AQUI';
const SITE = 'https://bmgrossi.github.io/amapa';

type Afirmacao = { texto: string; resposta: 'lei' | 'lenda'; norma: string; base: string };

const AFIRMACOES: Afirmacao[] = [
  {
    texto: 'Se o empregado concordou, a empresa está coberta.',
    resposta: 'lenda',
    norma: 'O acordo individual não afasta direito garantido em lei. Intervalo, limite de jornada e proteção não se negociam no corredor, e o termo assinado não transfere o dever.',
    base: 'CLT, arts. 9º e 444',
  },
  {
    texto: 'Quem começa o turno às 4h30 faz a primeira meia hora como hora comum.',
    resposta: 'lenda',
    norma: 'Das 22h às 5h a hora é noturna, com adicional e hora reduzida. A escala precisa mostrar a hora real de início.',
    base: 'CLT, art. 73',
  },
  {
    texto: 'A hora extra tem limite de duas por dia.',
    resposta: 'lei',
    norma: 'Até duas horas extras por dia, autorizadas antes e registradas, com adicional mínimo de 50%.',
    base: 'CLT, art. 59; CF, art. 7º, XVI',
  },
  {
    texto: 'Se o banco de horas não fecha, dá para ajustar as marcações no fim do mês.',
    resposta: 'lenda',
    norma: 'O ponto precisa retratar a jornada real. Marcação ajustada ou uniforme perde valor de prova, e a jornada alegada pelo empregado passa a prevalecer.',
    base: 'CLT, art. 74, § 2º; Súmula 338 do TST',
  },
  {
    texto: 'Recusar o EPI sem justificativa pode levar a advertência e até a justa causa.',
    resposta: 'lei',
    norma: 'A recusa injustificada ao uso do equipamento é ato faltoso. A gradação começa pela orientação e pela advertência registrada.',
    base: 'CLT, art. 158, parágrafo único, b',
  },
  {
    texto: 'Entregar o EPI e colher a assinatura encerra o dever da empresa.',
    resposta: 'lenda',
    norma: 'Além de fornecer, a empresa precisa orientar, substituir e fiscalizar o uso efetivo. Entregar não basta.',
    base: 'NR-6; Súmula 289 do TST',
  },
];
const TOTAL = AFIRMACOES.length;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}
function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
}

const dbHeaders = { apikey: SRK, Authorization: `Bearer ${SRK}`, 'Content-Type': 'application/json' };

async function db(method: string, path: string, body?: unknown, prefer?: string): Promise<any> {
  const headers: Record<string, string> = { ...dbHeaders };
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${REST}/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

type Estado = { rodada: number; atual: number; revelado: boolean };

async function lerEstado(): Promise<Estado> {
  const rows = await db('GET', `ll_estado?evento=eq.${EVENTO}&select=rodada,atual,revelado`);
  if (rows[0]) return rows[0];
  await db('POST', 'll_estado', { evento: EVENTO }, 'resolution=ignore-duplicates');
  return { rodada: 1, atual: 0, revelado: false };
}
async function gravarEstado(patch: Partial<Estado>): Promise<Estado> {
  const rows = await db('PATCH', `ll_estado?evento=eq.${EVENTO}`, { ...patch, atualizado_em: new Date().toISOString() }, 'return=representation');
  const r = rows[0];
  return { rodada: r.rodada, atual: r.atual, revelado: r.revelado };
}

// fase: 'espera' (antes da 1ª), 'votacao', 'fim' (depois da última)
function publico(e: Estado) {
  const fase = e.atual < 1 ? 'espera' : e.atual > TOTAL ? 'fim' : 'votacao';
  const out: Record<string, unknown> = { rodada: e.rodada, atual: e.atual, total: TOTAL, revelado: e.revelado, fase };
  if (fase === 'votacao') {
    const a = AFIRMACOES[e.atual - 1];
    out.texto = a.texto;
    if (e.revelado) Object.assign(out, { resposta: a.resposta, norma: a.norma, base: a.base });
  }
  return out;
}

async function contagem(rodada: number): Promise<{ lei: number; lenda: number }[]> {
  const rows = await db('GET', `ll_voto?evento=eq.${EVENTO}&rodada=eq.${rodada}&select=afirmacao,voto&limit=20000`);
  const c = AFIRMACOES.map(() => ({ lei: 0, lenda: 0 }));
  for (const r of rows) if (r.afirmacao >= 1 && r.afirmacao <= TOTAL) c[r.afirmacao - 1][r.voto as 'lei' | 'lenda']++;
  return c;
}

// ---------- API ----------

async function apiEstado(): Promise<Response> {
  return json(publico(await lerEstado()));
}

async function apiPainel(): Promise<Response> {
  const e = await lerEstado();
  const c = await contagem(e.rodada);
  const out: Record<string, unknown> = publico(e);
  if (e.atual >= 1 && e.atual <= TOTAL) out.votos = c[e.atual - 1];
  if (e.atual > TOTAL) {
    out.resumo = AFIRMACOES.map((a, i) => ({ n: i + 1, texto: a.texto, resposta: a.resposta, ...c[i] }));
  }
  return json(out);
}

const DISP_RE = /^[a-zA-Z0-9-]{8,64}$/;

async function apiVoto(req: Request): Promise<Response> {
  const b = await req.json().catch(() => null);
  if (!b || !DISP_RE.test(String(b.dispositivo)) || (b.voto !== 'lei' && b.voto !== 'lenda')) return json({ erro: 'voto inválido' }, 400);
  const e = await lerEstado();
  if (Number(b.rodada) !== e.rodada || Number(b.n) !== e.atual || e.atual < 1 || e.atual > TOTAL) {
    return json({ erro: 'esta afirmação já não está em votação', estado: publico(e) }, 409);
  }
  if (e.revelado) return json({ erro: 'a votação desta afirmação foi encerrada', estado: publico(e) }, 409);
  await db(
    'POST',
    'll_voto?on_conflict=evento,rodada,afirmacao,dispositivo',
    { evento: EVENTO, rodada: e.rodada, afirmacao: e.atual, dispositivo: b.dispositivo, voto: b.voto },
    'resolution=merge-duplicates',
  );
  return json({ ok: true });
}

async function apiAdmin(req: Request): Promise<Response> {
  const b = await req.json().catch(() => null);
  if (!b || b.chave !== CHAVE_ADMIN) return json({ erro: 'chave inválida' }, 401);
  const e = await lerEstado();
  switch (b.acao) {
    case 'verificar':
      return json({ ok: true });
    case 'ir': {
      const n = Math.max(0, Math.min(TOTAL + 1, Number(b.n) || 0));
      return json(publico(await gravarEstado({ atual: n, revelado: false })));
    }
    case 'revelar':
      return json(publico(await gravarEstado({ revelado: true })));
    case 'reabrir':
      return json(publico(await gravarEstado({ revelado: false })));
    case 'nova-rodada':
      return json(publico(await gravarEstado({ rodada: e.rodada + 1, atual: 0, revelado: false })));
    case 'semear': {
      // votos de teste na afirmação atual, marcados como demo
      if (e.atual < 1 || e.atual > TOTAL) return json({ erro: 'abra uma afirmação antes' }, 400);
      const linhas = [];
      for (let k = 0; k < 25; k++) {
        linhas.push({
          evento: EVENTO, rodada: e.rodada, afirmacao: e.atual, demo: true,
          dispositivo: 'demo-' + crypto.randomUUID(), voto: Math.random() < 0.55 ? 'lei' : 'lenda',
        });
      }
      await db('POST', 'll_voto', linhas);
      return json({ ok: true, inseridos: linhas.length });
    }
    case 'zerar-demo':
      await db('DELETE', `ll_voto?evento=eq.${EVENTO}&demo=is.true`);
      return json({ ok: true });
    case 'zerar-rodada':
      // apaga os votos da rodada e abre outra, para nenhum celular guardar voto antigo
      await db('DELETE', `ll_voto?evento=eq.${EVENTO}&rodada=eq.${e.rodada}`);
      return json(publico(await gravarEstado({ rodada: e.rodada + 1, atual: 0, revelado: false })));
  }
  return json({ erro: 'ação desconhecida' }, 400);
}

async function apiExport(url: URL): Promise<Response> {
  if (url.searchParams.get('chave') !== CHAVE_ADMIN) return json({ erro: 'chave inválida' }, 401);
  const rows = await db('GET', `ll_voto?evento=eq.${EVENTO}&demo=is.false&select=rodada,afirmacao,voto&limit=50000`);
  const m = new Map<string, { lei: number; lenda: number }>();
  for (const r of rows) {
    const k = `${r.rodada}|${r.afirmacao}`;
    const v = m.get(k) ?? { lei: 0, lenda: 0 };
    v[r.voto as 'lei' | 'lenda']++;
    m.set(k, v);
  }
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [['rodada', 'afirmacao', 'texto', 'resposta', 'votos_lei', 'votos_lenda', 'acerto_pct'].join(';')];
  for (const k of [...m.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const [rodada, n] = k.split('|').map(Number);
    const a = AFIRMACOES[n - 1];
    const v = m.get(k)!;
    const tot = v.lei + v.lenda;
    const pct = tot ? Math.round((100 * v[a.resposta]) / tot) : 0;
    linhas.push([rodada, n, esc(a.texto), a.resposta, v.lei, v.lenda, pct].join(';'));
  }
  return new Response('﻿' + linhas.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="lei-ou-lenda-amapa.csv"',
      ...CORS,
    },
  });
}

// ---------- roteamento ----------

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  let p = url.pathname;
  const ix = p.indexOf('/amapa');
  if (ix >= 0) p = p.slice(ix + '/amapa'.length);
  if (p === '' || p === '/index.html') p = '/';
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  try {
    if (p === '/') return redirect(`${SITE}/`);
    if (p === '/painel') return redirect(`${SITE}/painel/${url.search}`);
    if (req.method === 'GET' && p === '/api/estado') return await apiEstado();
    if (req.method === 'GET' && p === '/api/painel') return await apiPainel();
    if (req.method === 'POST' && p === '/api/voto') return await apiVoto(req);
    if (req.method === 'POST' && p === '/api/admin') return await apiAdmin(req);
    if (req.method === 'GET' && p === '/api/export') return await apiExport(url);
    return json({ erro: 'não encontrado' }, 404);
  } catch (err) {
    console.error('[amapa]', err);
    return json({ erro: 'erro interno' }, 500);
  }
});
