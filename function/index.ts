// Votação ao vivo — Liderança em Foco · Grupo Amapá (slides 24 e 25 de "O turno é nosso")
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

const LETRAS = ['A', 'B', 'C', 'D'] as const;
type Letra = typeof LETRAS[number];

// resposta: a letra certa, ou null nas perguntas de diagnóstico (sem resposta certa)
type Pergunta = { bloco: string; texto: string; alternativas: string[]; resposta: Letra | null; revela: string };

const BLOCO_CONTA = 'A conta ou a lei decide';
const BLOCO_DIAG = 'Diagnóstico, sem resposta certa';

const PERGUNTAS: Pergunta[] = [
  {
    bloco: BLOCO_CONTA,
    texto: 'Uma equipe de 21 pessoas mantém a grade de hoje depois de dezembro. Cobrir essas horas com hora extra custa quanto, em salário, frente a contratar a 22ª pessoa?',
    alternativas: ['Menos', 'O mesmo', 'Cerca de 30% a mais'],
    resposta: 'C',
    revela: 'Hora extra habitual é a forma mais cara de dimensionar uma equipe.',
  },
  {
    bloco: BLOCO_CONTA,
    texto: 'O que reduz mais o risco trabalhista de uma área?',
    alternativas: ['Zerar as horas extras', 'Limitá-las a duas por dia', 'Registrar todas as que forem feitas'],
    resposta: 'C',
    revela: 'A meta de zerar é a que mais empurra a hora para fora do registro.',
  },
  {
    bloco: BLOCO_CONTA,
    texto: 'Uma semana de pico está prevista para daqui a um mês. Qual instrumento a lei permite usar para absorvê-la sem pagar hora extra?',
    alternativas: ['Reduzir o intervalo de refeição nesses dias', 'Compensar as horas dentro do mesmo mês', 'Trabalhar no dia de repouso, com folga combinada para depois'],
    resposta: 'B',
    revela: 'Planejar com antecedência é o que transforma hora extra em compensação.',
  },
  {
    bloco: BLOCO_CONTA,
    texto: 'Para uma função com ruído acima do limite, o que pesa mais no custo ao longo de cinco anos?',
    alternativas: ['Pagar o adicional de insalubridade', 'Neutralizar o agente, com equipamento, troca e fiscalização', 'São equivalentes'],
    resposta: 'A',
    revela: 'Prevenir custa uma fração de remunerar a exposição.',
  },
  {
    bloco: BLOCO_DIAG,
    texto: 'Quando a hora extra se repete todo mês, ela é sintoma de quê?',
    alternativas: ['Demanda acima da capacidade', 'Planejamento que chega tarde', 'Equipe subdimensionada', 'Hábito'],
    resposta: null,
    revela: 'O que se repete deixou de ser extraordinário e passou a ser a forma de operar.',
  },
  {
    bloco: BLOCO_DIAG,
    texto: 'Qual custo da hora extra habitual menos aparece na folha?',
    alternativas: ['Os reflexos em repouso, férias, 13º e FGTS', 'A fadiga, com efeito em segurança e qualidade', 'A dependência da renda, que trava mudanças de escala'],
    resposta: null,
    revela: 'A sala costuma enxergar só o primeiro.',
  },
  {
    bloco: BLOCO_DIAG,
    texto: 'Que indicador a diretoria deveria ler ao lado das horas extras?',
    alternativas: ['Absenteísmo', 'Ajustes manuais de ponto', 'Produtividade por hora', 'Acidentes e quase acidentes'],
    resposta: null,
    revela: 'Jornada, registro e segurança no mesmo painel.',
  },
];
const TOTAL = PERGUNTAS.length;

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

function letrasDe(p: Pergunta): Letra[] {
  return LETRAS.slice(0, p.alternativas.length) as Letra[];
}

// fase: 'espera' (antes da 1ª), 'votacao', 'fim' (depois da última)
function publico(e: Estado) {
  const fase = e.atual < 1 ? 'espera' : e.atual > TOTAL ? 'fim' : 'votacao';
  const out: Record<string, unknown> = { rodada: e.rodada, atual: e.atual, total: TOTAL, revelado: e.revelado, fase };
  if (fase === 'votacao') {
    const p = PERGUNTAS[e.atual - 1];
    Object.assign(out, {
      bloco: p.bloco,
      texto: p.texto,
      alternativas: letrasDe(p).map((l, i) => ({ letra: l, texto: p.alternativas[i] })),
      diagnostico: p.resposta === null,
    });
    if (e.revelado) Object.assign(out, { resposta: p.resposta, revela: p.revela });
  }
  return out;
}

function zeros(p: Pergunta): Record<string, number> {
  const o: Record<string, number> = {};
  for (const l of letrasDe(p)) o[l] = 0;
  return o;
}

async function contagem(rodada: number): Promise<Record<string, number>[]> {
  const rows = await db('GET', `ll_voto?evento=eq.${EVENTO}&rodada=eq.${rodada}&select=afirmacao,voto&limit=20000`);
  const c = PERGUNTAS.map(zeros);
  for (const r of rows) {
    if (r.afirmacao < 1 || r.afirmacao > TOTAL) continue;
    const alvo = c[r.afirmacao - 1];
    if (r.voto in alvo) alvo[r.voto]++;
  }
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
    out.resumo = PERGUNTAS.map((p, i) => ({
      n: i + 1, bloco: p.bloco, texto: p.texto, resposta: p.resposta,
      alternativas: letrasDe(p).map((l, j) => ({ letra: l, texto: p.alternativas[j] })),
      votos: c[i],
    }));
  }
  return json(out);
}

const DISP_RE = /^[a-zA-Z0-9-]{8,64}$/;

async function apiVoto(req: Request): Promise<Response> {
  const b = await req.json().catch(() => null);
  if (!b || !DISP_RE.test(String(b.dispositivo))) return json({ erro: 'voto inválido' }, 400);
  const e = await lerEstado();
  if (Number(b.rodada) !== e.rodada || Number(b.n) !== e.atual || e.atual < 1 || e.atual > TOTAL) {
    return json({ erro: 'esta pergunta já não está em votação', estado: publico(e) }, 409);
  }
  if (e.revelado) return json({ erro: 'a votação desta pergunta foi encerrada', estado: publico(e) }, 409);
  const p = PERGUNTAS[e.atual - 1];
  if (!(letrasDe(p) as string[]).includes(b.voto)) return json({ erro: 'alternativa inválida' }, 400);
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
      // votos de teste na pergunta atual, marcados como demo
      if (e.atual < 1 || e.atual > TOTAL) return json({ erro: 'abra uma pergunta antes' }, 400);
      const ls = letrasDe(PERGUNTAS[e.atual - 1]);
      const linhas = [];
      for (let k = 0; k < 25; k++) {
        linhas.push({
          evento: EVENTO, rodada: e.rodada, afirmacao: e.atual, demo: true,
          dispositivo: 'demo-' + crypto.randomUUID(), voto: ls[Math.floor(Math.random() * ls.length)],
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
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (r.afirmacao < 1 || r.afirmacao > TOTAL) continue;
    const k = `${r.rodada}|${r.afirmacao}`;
    const v = m.get(k) ?? zeros(PERGUNTAS[r.afirmacao - 1]);
    if (r.voto in v) v[r.voto]++;
    m.set(k, v);
  }
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const linhas = [['rodada', 'pergunta', 'bloco', 'texto', 'resposta', 'A', 'B', 'C', 'D', 'total', 'acerto_pct'].join(';')];
  for (const k of [...m.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const [rodada, n] = k.split('|').map(Number);
    const p = PERGUNTAS[n - 1];
    const v = m.get(k)!;
    const tot = Object.values(v).reduce((s, x) => s + x, 0);
    const pct = p.resposta && tot ? Math.round((100 * (v[p.resposta] ?? 0)) / tot) : '';
    linhas.push([rodada, n, esc(p.bloco), esc(p.texto), p.resposta ?? 'sem resposta certa', v.A ?? '', v.B ?? '', v.C ?? '', v.D ?? '', tot, pct].join(';'));
  }
  return new Response('﻿' + linhas.join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="votacao-amapa.csv"',
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
