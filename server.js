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
__defs["page"]=function(module,exports){
module.exports = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#1A237E\">\n<title>ChequeCheck</title>\n<style>\n  :root {\n    --azul: #1A237E; --texto: #202124; --suave: #5F6368; --borde: #DADCE0;\n    --fondo: #ffffff; --campo: #FAFAFA;\n    --verde-bg:#E6F4EA; --verde:#1E8E3E; --verde-t:#0B5D22;\n    --amar-bg:#FEF7E0; --amar:#F9AB00; --amar-t:#7A5200;\n    --rojo-bg:#FCE8E6; --rojo:#D93025; --rojo-t:#8C1A12;\n    --gris-bg:#F1F3F4; --gris:#80868B; --gris-t:#3C4043;\n  }\n  @media (prefers-color-scheme: dark) {\n    :root { --fondo:#121212; --texto:#E8EAED; --suave:#9AA0A6; --borde:#3C4043; --campo:#1E1E1E; --azul:#8AB4F8; }\n  }\n  * { box-sizing: border-box; }\n  body { margin:0; background:var(--fondo); color:var(--texto);\n    font-family: system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif;\n    padding: 16px; padding-bottom: 60px; max-width: 520px; margin-inline: auto; }\n  h1 { font-size: 28px; margin: 12px 0 4px; color: var(--azul); }\n  .sub { color: var(--suave); margin: 0 0 18px; font-size: 15px; }\n  .demo { background:#FEF7E0; color:#7A5200; border-radius:8px; padding:8px 12px; font-size:13px; margin-bottom:14px; display:none; }\n  label { display:block; font-weight:600; font-size:14px; margin-bottom:6px; }\n  input { width:100%; font-size:17px; padding:12px 14px; border:1px solid var(--borde);\n    border-radius:10px; background:var(--campo); color:var(--texto); }\n  .fila { display:flex; gap:8px; margin-top:10px; }\n  .fila input:first-child { flex:1; } .fila input:last-child { flex:1.4; }\n  .link { background:none; border:0; color:#1A73E8; font-size:14px; padding:12px 0 0; cursor:pointer; }\n  .boton { width:100%; margin-top:18px; padding:14px; border:0; border-radius:10px;\n    background:#1A237E; color:#fff; font-size:17px; font-weight:600; cursor:pointer; }\n  .boton:disabled { opacity:.6; }\n  .error { color:#D93025; margin-top:12px; font-size:14px; }\n  .card { border:2px solid; border-radius:14px; padding:16px; margin-top:22px; }\n  .card h2 { margin:0; font-size:22px; display:flex; align-items:center; gap:10px; }\n  .punto { width:14px; height:14px; border-radius:50%; flex:none; }\n  .nombre { font-weight:600; margin-top:10px; color:#202124; }\n  .cuit { font-size:13px; color:#5F6368; margin-bottom:10px; }\n  .motivo { margin:4px 0; line-height:1.4; font-size:15px; }\n  .bloque { margin-top:14px; padding-top:10px; border-top:1px solid #9AA0A6; }\n  .bloque b { display:block; font-size:14px; margin-bottom:4px; color:#202124; }\n  .det { font-size:13px; color:#5F6368; margin-top:2px; }\n  .aviso { font-size:12px; color:#5F6368; margin-top:12px; line-height:1.4; }\n  .verde { background:var(--verde-bg); border-color:var(--verde); color:var(--verde-t); }\n  .verde .punto { background:var(--verde); }\n  .amarillo { background:var(--amar-bg); border-color:var(--amar); color:var(--amar-t); }\n  .amarillo .punto { background:var(--amar); }\n  .rojo { background:var(--rojo-bg); border-color:var(--rojo); color:var(--rojo-t); }\n  .rojo .punto { background:var(--rojo); }\n  .gris { background:var(--gris-bg); border-color:var(--gris); color:var(--gris-t); }\n  .gris .punto { background:var(--gris); }\n  .hist-cab { display:flex; justify-content:space-between; align-items:center; margin-top:28px; }\n  .hist { display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--borde); cursor:pointer; }\n  .hist .t { flex:1; } .hist .t div:first-child { font-size:15px; }\n  .hist .e { font-size:13px; font-weight:600; }\n  .hist .punto { width:12px; height:12px; }\n  .hist .punto.verde { background:var(--verde); } .hist .punto.amarillo { background:var(--amar); }\n  .hist .punto.rojo { background:var(--rojo); } .hist .punto.gris { background:var(--gris); }\n</style>\n</head>\n<body>\n  <h1>ChequeCheck</h1>\n  <p class=\"sub\">Consultá el riesgo del librador antes de aceptar un cheque.</p>\n  <div class=\"demo\" id=\"demo\">Modo demo: los resultados son datos de ejemplo, no reales.</div>\n\n  <label for=\"cuit\">CUIT / CUIL del librador</label>\n  <input id=\"cuit\" inputmode=\"numeric\" placeholder=\"20-12345678-6\" maxlength=\"13\" autocomplete=\"off\">\n\n  <button class=\"link\" id=\"toggle\" type=\"button\">+ Verificar si el cheque está denunciado</button>\n  <div class=\"fila\" id=\"chequeBox\" style=\"display:none\">\n    <input id=\"banco\" inputmode=\"numeric\" placeholder=\"Cód. banco (ej. 011)\">\n    <input id=\"cheque\" inputmode=\"numeric\" placeholder=\"Nº de cheque\">\n  </div>\n\n  <button class=\"boton\" id=\"buscar\" type=\"button\">Consultar</button>\n  <div class=\"error\" id=\"error\"></div>\n  <div id=\"resultado\"></div>\n\n  <div id=\"histWrap\" style=\"display:none\">\n    <div class=\"hist-cab\">\n      <label style=\"margin:0\">Consultas recientes</label>\n      <button class=\"link\" id=\"borrar\" type=\"button\" style=\"padding:0\">Borrar</button>\n    </div>\n    <div id=\"hist\"></div>\n  </div>\n\n<script>\n(function () {\n  var $ = function (id) { return document.getElementById(id); };\n  var KEY = 'chequecheck_hist_v1';\n\n  function limpiar(v) { return String(v || '').replace(/\\D/g, ''); }\n  function formatear(v) {\n    var d = limpiar(v).slice(0, 11);\n    if (d.length <= 2) return d;\n    if (d.length <= 10) return d.slice(0, 2) + '-' + d.slice(2);\n    return d.slice(0, 2) + '-' + d.slice(2, 10) + '-' + d.slice(10);\n  }\n  function valido(v) {\n    var c = limpiar(v);\n    if (!/^\\d{11}$/.test(c)) return false;\n    var p = [5,4,3,2,7,6,5,4,3,2], s = 0;\n    for (var i = 0; i < 10; i++) s += p[i] * Number(c[i]);\n    var dv = 11 - (s % 11);\n    if (dv === 11) dv = 0;\n    if (dv === 10) dv = 9;\n    return dv === Number(c[10]);\n  }\n  function pesos(miles) {\n    if (miles == null) return '—';\n    return '$ ' + Math.round(Number(miles) * 1000).toLocaleString('es-AR');\n  }\n  function el(tag, cls, texto) {\n    var e = document.createElement(tag);\n    if (cls) e.className = cls;\n    if (texto != null) e.textContent = texto;\n    return e;\n  }\n\n  function leerHist() {\n    try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }\n  }\n  function guardarHist(r) {\n    var item = {\n      cuit: r.cuit, semaforo: r.semaforo, titulo: r.titulo,\n      nombre: (r.resumen && r.resumen.denominacion) || null, fecha: r.consultadoEn\n    };\n    var lista = [item].concat(leerHist().filter(function (h) { return h.cuit !== item.cuit; })).slice(0, 30);\n    try { localStorage.setItem(KEY, JSON.stringify(lista)); } catch (e) {}\n    pintarHist();\n  }\n  function pintarHist() {\n    var lista = leerHist(), cont = $('hist');\n    cont.textContent = '';\n    $('histWrap').style.display = lista.length ? 'block' : 'none';\n    lista.forEach(function (h) {\n      var fila = el('div', 'hist');\n      fila.appendChild(el('span', 'punto ' + (h.semaforo || 'gris')));\n      var t = el('div', 't');\n      t.appendChild(el('div', null, h.nombre || formatear(h.cuit)));\n      t.appendChild(el('div', 'det', formatear(h.cuit) + ' · ' + new Date(h.fecha).toLocaleDateString('es-AR')));\n      fila.appendChild(t);\n      fila.appendChild(el('span', 'e', h.titulo));\n      fila.addEventListener('click', function () { $('cuit').value = formatear(h.cuit); consultar(); });\n      cont.appendChild(fila);\n    });\n  }\n\n  function mostrar(r) {\n    var cont = $('resultado');\n    cont.textContent = '';\n    var card = el('div', 'card ' + (r.semaforo || 'gris'));\n    var h2 = el('h2');\n    h2.appendChild(el('span', 'punto'));\n    h2.appendChild(el('span', null, r.titulo));\n    card.appendChild(h2);\n    var res = r.resumen || {};\n    if (res.denominacion) card.appendChild(el('div', 'nombre', res.denominacion));\n    card.appendChild(el('div', 'cuit', 'CUIT ' + formatear(r.cuit)));\n    (r.motivos || []).forEach(function (m) { card.appendChild(el('div', 'motivo', '• ' + m)); });\n\n    if (res.entidades && res.entidades.length) {\n      var b = el('div', 'bloque');\n      b.appendChild(el('b', null, 'Deuda informada (' + res.periodoUltimo + '): ' + pesos(res.deudaTotalMilesARS)));\n      res.entidades.forEach(function (e) {\n        b.appendChild(el('div', 'det', e.entidad + ' · situación ' + e.situacion + ' · ' + pesos(e.monto)));\n      });\n      card.appendChild(b);\n    }\n    if (res.chequesRechazados && res.chequesRechazados.length) {\n      var b2 = el('div', 'bloque');\n      b2.appendChild(el('b', null, 'Cheques rechazados'));\n      res.chequesRechazados.slice(0, 10).forEach(function (q) {\n        b2.appendChild(el('div', 'det',\n          'N° ' + q.nroCheque + ' · ' + q.fechaRechazo + ' · ' + pesos(q.monto / 1000) + ' · ' +\n          (q.fechaPago ? 'regularizado' : 'SIN REGULARIZAR')));\n      });\n      card.appendChild(b2);\n    }\n    if (r.aviso) card.appendChild(el('div', 'aviso', r.aviso));\n    if (typeof r.consultasRestantesHoy === 'number')\n      card.appendChild(el('div', 'aviso', 'Consultas restantes hoy: ' + r.consultasRestantesHoy));\n    cont.appendChild(card);\n  }\n\n  function consultar() {\n    var cuit = limpiar($('cuit').value);\n    $('error').textContent = '';\n    if (!valido(cuit)) { $('error').textContent = 'El CUIT/CUIL no es válido. Revisá los 11 dígitos.'; return; }\n    var params = new URLSearchParams({ cuit: cuit });\n    if ($('chequeBox').style.display !== 'none') {\n      if ($('banco').value.trim()) params.set('banco', $('banco').value.trim());\n      if ($('cheque').value.trim()) params.set('cheque', $('cheque').value.trim());\n    }\n    var btn = $('buscar');\n    btn.disabled = true; btn.textContent = 'Consultando…';\n    $('resultado').textContent = '';\n    var ctrl = new AbortController();\n    var t = setTimeout(function () { ctrl.abort(); }, 70000); // el plan gratis puede tardar en \"despertar\"\n    fetch('/api/check?' + params.toString(), { signal: ctrl.signal })\n      .then(function (res) {\n        return res.json().catch(function () { return {}; }).then(function (body) {\n          if (!res.ok) throw new Error(body.error || ('Error ' + res.status));\n          return body;\n        });\n      })\n      .then(function (r) { mostrar(r); guardarHist(r); })\n      .catch(function (e) {\n        $('error').textContent = e.name === 'AbortError'\n          ? 'La consulta tardó demasiado. Probá de nuevo.' : (e.message || 'No se pudo consultar.');\n      })\n      .finally(function () { clearTimeout(t); btn.disabled = false; btn.textContent = 'Consultar'; });\n  }\n\n  $('cuit').addEventListener('input', function (e) { e.target.value = formatear(e.target.value); });\n  $('cuit').addEventListener('keydown', function (e) { if (e.key === 'Enter') consultar(); });\n  $('buscar').addEventListener('click', consultar);\n  $('toggle').addEventListener('click', function () {\n    var abierto = $('chequeBox').style.display !== 'none';\n    $('chequeBox').style.display = abierto ? 'none' : 'flex';\n    $('toggle').textContent = abierto ? '+ Verificar si el cheque está denunciado' : '− Ocultar datos del cheque';\n  });\n  $('borrar').addEventListener('click', function () {\n    try { localStorage.removeItem(KEY); } catch (e) {}\n    pintarHist();\n  });\n\n  fetch('/health').then(function (r) { return r.json(); })\n    .then(function (h) { if (h && h.mock) $('demo').style.display = 'block'; })\n    .catch(function () {});\n  pintarHist();\n})();\n</script>\n</body>\n</html>\n";
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
const PAGE = __req('./page');

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
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }

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
