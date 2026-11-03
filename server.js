// Backend ChequeCheck (archivo único para desplegar)
const __defs={};const __cache={};
function __req(n){if(n.startsWith("./")){const k=n.slice(2).replace(/\.js$/,"");if(!__cache[k]){const m={exports:{}};__cache[k]=m;__defs[k](m,m.exports);}return __cache[k].exports;}return require(n);}
__defs["cuit"]=function(module,exports){
// Validación de CUIT/CUIL (11 dígitos, dígito verificador módulo 11)
function limpiarCuit(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function validarCuit(valor) {
  const cuit = limpiarCuit(valor);
  if (!/^\d{11}$/.test(cuit)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(cuit[i]), 0);
  let dv = 11 - (suma % 11);
  if (dv === 11) dv = 0;
  if (dv === 10) dv = 9; // caso especial usado por AFIP para prefijos 23
  return dv === Number(cuit[10]);
}

module.exports = { limpiarCuit, validarCuit };

};
__defs["risk"]=function(module,exports){
// Lógica del semáforo de riesgo. Funciones puras, fáciles de testear.
// Entrada: respuestas ya normalizadas de la API del BCRA.

const SITUACION_TEXTO = {
  1: 'Normal',
  2: 'Con seguimiento especial / riesgo bajo',
  3: 'Con problemas / riesgo medio',
  4: 'Con alto riesgo de insolvencia',
  5: 'Irrecuperable',
  6: 'Irrecuperable por disposición técnica',
};

function ultimoPeriodo(deudas) {
  const periodos = (deudas && deudas.periodos) || [];
  if (!periodos.length) return null;
  return [...periodos].sort((a, b) => String(b.periodo).localeCompare(String(a.periodo)))[0];
}

function peorSituacion(periodo) {
  if (!periodo || !periodo.entidades || !periodo.entidades.length) return null;
  return Math.max(...periodo.entidades.map((e) => Number(e.situacion) || 1));
}

function peorSituacionHistorica(historicas, meses = 12) {
  const periodos = (historicas && historicas.periodos) || [];
  const recientes = [...periodos]
    .sort((a, b) => String(b.periodo).localeCompare(String(a.periodo)))
    .slice(0, meses);
  let peor = null;
  for (const p of recientes) {
    const s = peorSituacion(p);
    if (s !== null && (peor === null || s > peor)) peor = s;
  }
  return peor;
}

function aplanarRechazados(rechazados) {
  const salida = [];
  for (const c of (rechazados && rechazados.causales) || []) {
    for (const ent of c.entidades || []) {
      for (const d of ent.detalle || []) {
        salida.push({
          causal: c.causal,
          entidad: ent.entidad,
          nroCheque: d.nroCheque,
          fechaRechazo: d.fechaRechazo,
          monto: d.monto,
          fechaPago: d.fechaPago || null,
          fechaPagoMulta: d.fechaPagoMulta || null,
          estadoMulta: d.estadoMulta || null,
        });
      }
    }
  }
  return salida;
}

function mesesDesde(fechaISO, hoy = new Date()) {
  const f = new Date(fechaISO);
  if (isNaN(f)) return null;
  return (hoy.getFullYear() - f.getFullYear()) * 12 + (hoy.getMonth() - f.getMonth());
}

const ORDEN = { verde: 0, amarillo: 1, rojo: 2, gris: -1 };
function peor(a, b) {
  return ORDEN[b] > ORDEN[a] ? b : a;
}

/**
 * @param {object} p
 * @param {object|null} p.deudas       results de /Deudas/{id}
 * @param {object|null} p.historicas   results de /Deudas/Historicas/{id}
 * @param {object|null} p.rechazados   results de /Deudas/ChequesRechazados/{id}
 * @param {object|null} p.denunciado   resultado de consulta de cheque denunciado (opcional)
 */
function evaluarRiesgo({ deudas, historicas, rechazados, denunciado }, hoy = new Date()) {
  const motivos = [];
  let semaforo = 'verde';

  const sinDatos = !deudas && !historicas && !rechazados;
  if (sinDatos && !denunciado) {
    return {
      semaforo: 'gris',
      titulo: 'Sin información',
      motivos: ['No se pudo obtener información del BCRA para este CUIT.'],
      resumen: {},
    };
  }

  // 1) Cheque denunciado: lo más grave.
  if (denunciado && denunciado.denunciado) {
    semaforo = 'rojo';
    motivos.push('El cheque figura DENUNCIADO (robo, extravío o adulteración). No lo aceptes.');
  }

  // 2) Situación crediticia actual
  const periodo = ultimoPeriodo(deudas);
  const sitActual = peorSituacion(periodo);
  if (sitActual === null) {
    motivos.push('Sin deudas informadas en el sistema financiero en el último período.');
  } else if (sitActual >= 3) {
    semaforo = peor(semaforo, 'rojo');
    motivos.push(`Situación crediticia actual ${sitActual} (${SITUACION_TEXTO[sitActual]}).`);
  } else if (sitActual === 2) {
    semaforo = peor(semaforo, 'amarillo');
    motivos.push('Situación crediticia actual 2 (seguimiento especial).');
  } else {
    motivos.push('Situación crediticia actual 1 (normal).');
  }

  // 3) Peor situación en últimos 12 meses (si empeoró y ya volvió, es señal de atención)
  const sitHist = peorSituacionHistorica(historicas, 12);
  if (sitHist !== null && sitHist >= 3 && (sitActual === null || sitActual < 3)) {
    semaforo = peor(semaforo, 'amarillo');
    motivos.push(`En los últimos 12 meses llegó a situación ${sitHist}.`);
  } else if (sitHist === 2 && (sitActual === null || sitActual < 2)) {
    semaforo = peor(semaforo, 'amarillo');
    motivos.push('En los últimos 12 meses tuvo situación 2.');
  }

  // 4) Procesos judiciales / refinanciaciones en el último período
  if (periodo && periodo.entidades) {
    if (periodo.entidades.some((e) => e.procesoJud)) {
      semaforo = peor(semaforo, 'rojo');
      motivos.push('Tiene deudas en proceso judicial.');
    }
    if (periodo.entidades.some((e) => e.situacionJuridica)) {
      semaforo = peor(semaforo, 'rojo');
      motivos.push('Registra situación jurídica (concurso/quiebra u otra).');
    }
    if (periodo.entidades.some((e) => e.refinanciaciones || e.recategOblig)) {
      semaforo = peor(semaforo, 'amarillo');
      motivos.push('Tiene deudas refinanciadas o recategorizadas.');
    }
  }

  // 5) Cheques rechazados
  const chq = aplanarRechazados(rechazados);
  const impagos = chq.filter((c) => !c.fechaPago);
  const pagos = chq.filter((c) => c.fechaPago);
  const multasImpagas = chq.filter(
    (c) => c.fechaPago && !c.fechaPagoMulta && c.estadoMulta && /impaga|sin/i.test(String(c.estadoMulta))
  );
  if (impagos.length) {
    semaforo = peor(semaforo, 'rojo');
    motivos.push(`${impagos.length} cheque(s) rechazado(s) sin regularizar.`);
  }
  if (multasImpagas.length) {
    semaforo = peor(semaforo, 'amarillo');
    motivos.push(`${multasImpagas.length} multa(s) por cheque rechazado sin pagar.`);
  }
  const pagosRecientes = pagos.filter((c) => {
    const m = mesesDesde(c.fechaRechazo, hoy);
    return m !== null && m <= 24;
  });
  if (pagosRecientes.length) {
    semaforo = peor(semaforo, 'amarillo');
    motivos.push(`${pagosRecientes.length} cheque(s) rechazado(s) en los últimos 24 meses (ya regularizados).`);
  }
  if (!chq.length && (deudas || historicas || rechazados)) {
    motivos.push('Sin cheques rechazados informados.');
  }

  const titulos = {
    verde: 'Riesgo bajo',
    amarillo: 'Precaución',
    rojo: 'Riesgo alto',
  };

  return {
    semaforo,
    titulo: titulos[semaforo],
    motivos,
    resumen: {
      denominacion:
        (deudas && deudas.denominacion) ||
        (rechazados && rechazados.denominacion) ||
        (historicas && historicas.denominacion) ||
        null,
      situacionActual: sitActual,
      peorSituacion12m: sitHist,
      periodoUltimo: periodo ? periodo.periodo : null,
      deudaTotalMilesARS: periodo
        ? periodo.entidades.reduce((a, e) => a + (Number(e.monto) || 0), 0)
        : null,
      entidades: periodo
        ? periodo.entidades.map((e) => ({ entidad: e.entidad, situacion: e.situacion, monto: e.monto }))
        : [],
      chequesRechazados: chq,
    },
  };
}

module.exports = { evaluarRiesgo, aplanarRechazados, peorSituacion, ultimoPeriodo };

};
__defs["mock"]=function(module,exports){
// Datos de demostración (MOCK=1) para probar la app sin llamar al BCRA.
// El último dígito del CUIT decide el escenario: 0-3 verde, 4-6 amarillo, 7-9 rojo.

function periodos(sit, extra = {}) {
  return ['202509', '202508', '202507'].map((p) => ({
    periodo: p,
    entidades: [{ entidad: 'BANCO DEMO S.A.', situacion: sit, monto: 850, diasAtrasoPago: sit > 1 ? 60 : 0, ...extra }],
  }));
}

function mock(cuit) {
  const d = Number(cuit[10]);
  const base = { identificacion: Number(cuit), denominacion: 'PERSONA DE EJEMPLO S.A.' };
  if (d <= 3) {
    return {
      deudas: { ...base, periodos: periodos(1).slice(0, 1) },
      historicas: { ...base, periodos: periodos(1) },
      rechazados: { ...base, causales: [] },
    };
  }
  if (d <= 6) {
    return {
      deudas: { ...base, periodos: periodos(2).slice(0, 1) },
      historicas: { ...base, periodos: periodos(2) },
      rechazados: {
        ...base,
        causales: [
          {
            causal: 'Sin fondos suficientes',
            entidades: [
              {
                entidad: 11,
                detalle: [
                  { nroCheque: 123456, fechaRechazo: '2025-06-10', monto: 150000, fechaPago: '2025-06-20', fechaPagoMulta: '2025-07-01', estadoMulta: 'Pagada' },
                ],
              },
            ],
          },
        ],
      },
    };
  }
  return {
    deudas: { ...base, periodos: periodos(4, { procesoJud: true }).slice(0, 1) },
    historicas: { ...base, periodos: periodos(4) },
    rechazados: {
      ...base,
      causales: [
        {
          causal: 'Sin fondos suficientes',
          entidades: [
            { entidad: 11, detalle: [{ nroCheque: 987654, fechaRechazo: '2026-09-02', monto: 480000, fechaPago: null, fechaPagoMulta: null, estadoMulta: 'Impaga' }] },
          ],
        },
      ],
    },
  };
}

module.exports = { mock };

};
__defs["bcra"]=function(module,exports){
// Cliente de la API pública del BCRA (https://api.bcra.gob.ar).
// Si hay problemas de certificado (cadena incompleta), usá NODE_EXTRA_CA_CERTS con el CA correcto;
// no desactives la verificación TLS.

const BASE = process.env.BCRA_BASE || 'https://api.bcra.gob.ar';
const TIMEOUT_MS = Number(process.env.BCRA_TIMEOUT_MS || 10000);

async function getJson(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new Error(`BCRA respondió ${res.status} en ${path}`);
    const body = await res.json();
    return { data: body.results || null };
  } finally {
    clearTimeout(t);
  }
}

async function consultarDeudas(cuit) {
  const r = await getJson(`/centraldedeudores/v1.0/Deudas/${cuit}`);
  return r.data || null;
}

async function consultarHistoricas(cuit) {
  const r = await getJson(`/centraldedeudores/v1.0/Deudas/Historicas/${cuit}`);
  return r.data || null;
}

async function consultarRechazados(cuit) {
  const r = await getJson(`/centraldedeudores/v1.0/Deudas/ChequesRechazados/${cuit}`);
  return r.data || null;
}

async function consultarDenunciado(codigoEntidad, numeroCheque) {
  const r = await getJson(
    `/cheques/v1.0/denunciados/${encodeURIComponent(codigoEntidad)}/${encodeURIComponent(numeroCheque)}`
  );
  if (r.notFound) return { denunciado: false };
  return { denunciado: true, detalle: r.data };
}

module.exports = { consultarDeudas, consultarHistoricas, consultarRechazados, consultarDenunciado };

};
__defs["server"]=function(module,exports){
// Servidor sin dependencias externas (Node 18+).
// GET /health
// GET /api/check?cuit=XXXXXXXXXXX[&banco=011&cheque=12345678]
//   Header opcional: x-api-key (si API_KEYS está definida es obligatorio)

const http = __req('node:http');
const { limpiarCuit, validarCuit } = __req('./cuit');
const { evaluarRiesgo } = __req('./risk');
const bcra = __req('./bcra');
const { mock } = __req('./mock');

const PORT = Number(process.env.PORT || 3000);
const MOCK = process.env.MOCK === '1';
const API_KEYS = (process.env.API_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 20); // consultas por clave/IP por día
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const DISCLAIMER =
  'Información orientativa tomada de la Central de Deudores del BCRA. No garantiza el cobro del cheque ni reemplaza el análisis propio.';

const cache = new Map(); // cuit -> { t, data }
const uso = new Map(); // clave -> { dia, n }

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-api-key, content-type',
  });
  res.end(json);
}

function controlarUso(clave) {
  const dia = new Date().toISOString().slice(0, 10);
  const u = uso.get(clave);
  if (!u || u.dia !== dia) {
    uso.set(clave, { dia, n: 1 });
    return { ok: true, restantes: DAILY_LIMIT - 1 };
  }
  if (u.n >= DAILY_LIMIT) return { ok: false, restantes: 0 };
  u.n += 1;
  return { ok: true, restantes: DAILY_LIMIT - u.n };
}

async function datosCuit(cuit) {
  const hit = cache.get(cuit);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;
  let data;
  if (MOCK) {
    data = mock(cuit);
  } else {
    const [deudas, historicas, rechazados] = await Promise.all([
      bcra.consultarDeudas(cuit),
      bcra.consultarHistoricas(cuit),
      bcra.consultarRechazados(cuit),
    ]);
    data = { deudas, historicas, rechazados };
  }
  cache.set(cuit, { t: Date.now(), data });
  return data;
}

async function manejar(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url.pathname === '/health') return send(res, 200, { ok: true, mock: MOCK });

  if (url.pathname !== '/api/check' || req.method !== 'GET') {
    return send(res, 404, { error: 'No encontrado' });
  }

  const key = req.headers['x-api-key'];
  if (API_KEYS.length && !API_KEYS.includes(key)) {
    return send(res, 401, { error: 'API key inválida' });
  }

  const cuit = limpiarCuit(url.searchParams.get('cuit'));
  if (!validarCuit(cuit)) {
    return send(res, 400, { error: 'CUIT/CUIL inválido' });
  }

  const clave = key || req.socket.remoteAddress || 'anon';
  const uso1 = controlarUso(clave);
  if (!uso1.ok) {
    return send(res, 429, { error: 'Alcanzaste el límite diario de consultas' });
  }

  try {
    const datos = await datosCuit(cuit);
    const banco = (url.searchParams.get('banco') || '').trim();
    const cheque = (url.searchParams.get('cheque') || '').trim();
    let denunciado = null;
    if (banco && cheque && !MOCK) {
      denunciado = await bcra.consultarDenunciado(banco, cheque);
    }
    const resultado = evaluarRiesgo({ ...datos, denunciado });
    return send(res, 200, {
      cuit,
      consultadoEn: new Date().toISOString(),
      consultasRestantesHoy: uso1.restantes,
      aviso: DISCLAIMER,
      ...resultado,
    });
  } catch (err) {
    console.error('Error consultando BCRA:', err.message);
    return send(res, 502, { error: 'No se pudo consultar el BCRA. Probá de nuevo en unos minutos.' });
  }
}

if (true) {
  http.createServer(manejar).listen(PORT, () => {
    console.log(`Backend en http://localhost:${PORT} ${MOCK ? '(modo demo)' : ''}`);
  });
}

module.exports = { manejar };

};
__req("./server");
