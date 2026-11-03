// Backend Nexo Cheques (archivo único para desplegar)
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
module.exports = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#051A39\">\n<meta name=\"application-name\" content=\"Nexo Cheques\">\n<meta name=\"apple-mobile-web-app-title\" content=\"Nexo Cheques\">\n<title>Nexo Cheques</title>\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23051A39'/%3E%3Cpath d='M40 12h10L26 52H16z' fill='%235A9B23'/%3E%3C/svg%3E\">\n<style>\n  :root {\n    --navy:#051A39; --navy2:#0B2A57; --verde:#5A9B23; --teal:#015C4D;\n    --fondo:#F3F6FA; --card:#FFFFFF; --texto:#0F1B2D; --suave:#5B6B82; --borde:#DCE3EC;\n    --ok:#1E8E3E; --ok-bg:#E8F5EC; --ok-t:#0B5D22;\n    --warn:#E39B00; --warn-bg:#FEF6DD; --warn-t:#7A5200;\n    --bad:#D93025; --bad-bg:#FDECEA; --bad-t:#8C1A12;\n    --neu:#80868B; --neu-bg:#F1F3F4; --neu-t:#3C4043;\n  }\n  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }\n  html { color-scheme: light; }\n  body { margin:0; background:var(--fondo); color:var(--texto);\n    font-family: system-ui,-apple-system,\"Segoe UI\",Roboto,Helvetica,Arial,sans-serif; line-height:1.4; }\n\n  header { background:#fff; border-bottom:1px solid var(--borde); }\n  .wrap { max-width:520px; margin:0 auto; padding:0 16px; }\n  .logo-box { padding:14px 0 12px; display:flex; justify-content:center; }\n  .logo-box img { height:64px; width:auto; display:block; }\n  .barra { height:4px; background:linear-gradient(90deg,var(--verde) 0 30%,var(--teal) 30% 70%,var(--navy) 70% 100%); }\n\n  .hero { background:linear-gradient(135deg,var(--navy) 0%,var(--navy2) 100%); color:#fff; padding:22px 0 54px; }\n  .hero h1 { margin:0; font-size:26px; letter-spacing:.2px; }\n  .hero h1 span { color:#9BD35A; }\n  .hero p { margin:6px 0 0; color:#C5D2E6; font-size:15px; }\n\n  main.wrap { margin-top:-34px; padding-bottom:24px; }\n  .card { background:var(--card); border-radius:16px; padding:18px; box-shadow:0 6px 24px rgba(5,26,57,.10); border:1px solid #E6ECF4; }\n  .demo { background:var(--warn-bg); color:var(--warn-t); border-radius:10px; padding:8px 12px; font-size:13px; margin-bottom:14px; display:none; }\n  label { display:block; font-weight:600; font-size:14px; margin-bottom:6px; color:var(--navy); }\n  input { width:100%; font-size:18px; padding:13px 14px; border:1.5px solid var(--borde); border-radius:12px;\n    background:#FAFBFD; color:var(--texto); outline:none; transition:border-color .15s, box-shadow .15s; }\n  input:focus { border-color:var(--verde); box-shadow:0 0 0 3px rgba(90,155,35,.18); background:#fff; }\n  .fila { display:flex; gap:8px; margin-top:10px; }\n  .fila input:first-child { flex:1; } .fila input:last-child { flex:1.4; }\n  .link { background:none; border:0; color:var(--teal); font-weight:600; font-size:14px; padding:14px 0 0; cursor:pointer; }\n  .boton { width:100%; margin-top:16px; padding:15px; border:0; border-radius:12px; cursor:pointer;\n    background:linear-gradient(135deg,var(--verde),#4A8A1B); color:#fff; font-size:17px; font-weight:700;\n    box-shadow:0 4px 12px rgba(90,155,35,.35); }\n  .boton:active { transform:translateY(1px); }\n  .boton:disabled { opacity:.65; }\n  .error { color:var(--bad); margin-top:12px; font-size:14px; min-height:0; }\n\n  .res { margin-top:18px; border-radius:16px; overflow:hidden; border:1px solid; background:#fff; box-shadow:0 6px 24px rgba(5,26,57,.08); }\n  .res-top { padding:16px 18px; display:flex; align-items:center; gap:14px; }\n  .semaforo { width:46px; height:46px; border-radius:50%; flex:none; display:grid; place-items:center; color:#fff; font-size:24px; font-weight:800; }\n  .res-top h2 { margin:0; font-size:22px; }\n  .res-top .sub { font-size:13px; opacity:.85; margin-top:2px; }\n  .res-body { padding:14px 18px 18px; }\n  .nombre { font-size:17px; font-weight:700; color:var(--navy); }\n  .cuit { font-size:13px; color:var(--suave); margin-bottom:10px; }\n  .motivo { display:flex; gap:8px; margin:6px 0; font-size:15px; }\n  .motivo i { font-style:normal; flex:none; width:18px; text-align:center; }\n  .escala { display:flex; gap:6px; margin:14px 0 2px; }\n  .escala div { flex:1; text-align:center; padding:6px 0; border-radius:8px; font-size:13px; font-weight:700;\n    background:#EEF2F7; color:#8A97AB; }\n  .escala-t { font-size:12px; color:var(--suave); margin-bottom:4px; }\n  .bloque { margin-top:14px; padding-top:12px; border-top:1px solid var(--borde); }\n  .bloque b { display:block; font-size:14px; margin-bottom:6px; color:var(--navy); }\n  .det { font-size:13px; color:var(--suave); margin-top:3px; }\n  .det.mal { color:var(--bad); font-weight:600; }\n  .aviso { font-size:12px; color:var(--suave); margin-top:14px; line-height:1.45; }\n\n  .t-verde { border-color:var(--ok); } .t-verde .res-top { background:var(--ok-bg); color:var(--ok-t); } .t-verde .semaforo { background:var(--ok); }\n  .t-amarillo { border-color:var(--warn); } .t-amarillo .res-top { background:var(--warn-bg); color:var(--warn-t); } .t-amarillo .semaforo { background:var(--warn); }\n  .t-rojo { border-color:var(--bad); } .t-rojo .res-top { background:var(--bad-bg); color:var(--bad-t); } .t-rojo .semaforo { background:var(--bad); }\n  .t-gris { border-color:var(--neu); } .t-gris .res-top { background:var(--neu-bg); color:var(--neu-t); } .t-gris .semaforo { background:var(--neu); }\n  .e-verde { background:var(--ok) !important; color:#fff !important; }\n  .e-amarillo { background:var(--warn) !important; color:#fff !important; }\n  .e-rojo { background:var(--bad) !important; color:#fff !important; }\n\n  .hist-cab { display:flex; justify-content:space-between; align-items:center; margin:26px 0 6px; }\n  .hist-cab span { font-weight:700; color:var(--navy); font-size:15px; }\n  .hist-cab .link { padding:0; }\n  .hist { display:flex; align-items:center; gap:12px; padding:12px 14px; background:#fff; border:1px solid var(--borde);\n    border-radius:12px; margin-top:8px; cursor:pointer; }\n  .hist .p { width:12px; height:12px; border-radius:50%; flex:none; }\n  .p.verde { background:var(--ok); } .p.amarillo { background:var(--warn); } .p.rojo { background:var(--bad); } .p.gris { background:var(--neu); }\n  .hist .t { flex:1; min-width:0; } .hist .t div:first-child { font-size:15px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }\n  .hist .e { font-size:12px; font-weight:700; color:var(--suave); }\n\n  footer { text-align:center; color:var(--suave); font-size:12px; padding:18px 16px 30px; }\n  footer b { color:var(--navy); }\n</style>\n</head>\n<body>\n  <header>\n    <div class=\"wrap\"><div class=\"logo-box\"><img src=\"data:image/png;base64,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\" alt=\"Nexo Soluciones Empresariales\"></div></div>\n    <div class=\"barra\"></div>\n  </header>\n\n  <section class=\"hero\">\n    <div class=\"wrap\">\n      <h1>Nexo <span>Cheques</span></h1>\n      <p>Consultá el riesgo del librador antes de aceptar un cheque.</p>\n    </div>\n  </section>\n\n  <main class=\"wrap\">\n    <div class=\"card\">\n      <div class=\"demo\" id=\"demo\">Modo demo: los resultados son datos de ejemplo, no reales.</div>\n      <label for=\"cuit\">CUIT / CUIL del librador</label>\n      <input id=\"cuit\" inputmode=\"numeric\" placeholder=\"20-12345678-6\" maxlength=\"13\" autocomplete=\"off\">\n\n      <button class=\"link\" id=\"toggle\" type=\"button\">+ Verificar si el cheque está denunciado</button>\n      <div class=\"fila\" id=\"chequeBox\" style=\"display:none\">\n        <input id=\"banco\" inputmode=\"numeric\" placeholder=\"Cód. banco (ej. 011)\">\n        <input id=\"cheque\" inputmode=\"numeric\" placeholder=\"Nº de cheque\">\n      </div>\n\n      <button class=\"boton\" id=\"buscar\" type=\"button\">Consultar</button>\n      <div class=\"error\" id=\"error\"></div>\n    </div>\n\n    <div id=\"resultado\"></div>\n\n    <div id=\"histWrap\" style=\"display:none\">\n      <div class=\"hist-cab\">\n        <span>Consultas recientes</span>\n        <button class=\"link\" id=\"borrar\" type=\"button\">Borrar</button>\n      </div>\n      <div id=\"hist\"></div>\n    </div>\n  </main>\n\n  <footer>\n    <b>Nexo Soluciones Empresariales</b><br>\n    Información orientativa de la Central de Deudores del BCRA.\n  </footer>\n\n<script>\n(function () {\n  var $ = function (id) { return document.getElementById(id); };\n  var KEY = 'nexocheques_hist_v1';\n  var ICONO = { verde: '✓', amarillo: '!', rojo: '✕', gris: '?' };\n  var NOMBRES = { 1: 'Normal', 2: 'Seguimiento', 3: 'Con problemas', 4: 'Alto riesgo', 5: 'Irrecuperable' };\n\n  function limpiar(v) { return String(v || '').replace(/\\D/g, ''); }\n  function formatear(v) {\n    var d = limpiar(v).slice(0, 11);\n    if (d.length <= 2) return d;\n    if (d.length <= 10) return d.slice(0, 2) + '-' + d.slice(2);\n    return d.slice(0, 2) + '-' + d.slice(2, 10) + '-' + d.slice(10);\n  }\n  function valido(v) {\n    var c = limpiar(v);\n    if (!/^\\d{11}$/.test(c)) return false;\n    var p = [5,4,3,2,7,6,5,4,3,2], s = 0;\n    for (var i = 0; i < 10; i++) s += p[i] * Number(c[i]);\n    var dv = 11 - (s % 11);\n    if (dv === 11) dv = 0;\n    if (dv === 10) dv = 9;\n    return dv === Number(c[10]);\n  }\n  function pesos(miles) {\n    if (miles == null) return '—';\n    return '$ ' + Math.round(Number(miles) * 1000).toLocaleString('es-AR');\n  }\n  function el(tag, cls, texto) {\n    var e = document.createElement(tag);\n    if (cls) e.className = cls;\n    if (texto != null) e.textContent = texto;\n    return e;\n  }\n\n  function leerHist() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }\n  function guardarHist(r) {\n    var item = { cuit: r.cuit, semaforo: r.semaforo, titulo: r.titulo,\n      nombre: (r.resumen && r.resumen.denominacion) || null, fecha: r.consultadoEn };\n    var lista = [item].concat(leerHist().filter(function (h) { return h.cuit !== item.cuit; })).slice(0, 30);\n    try { localStorage.setItem(KEY, JSON.stringify(lista)); } catch (e) {}\n    pintarHist();\n  }\n  function pintarHist() {\n    var lista = leerHist(), cont = $('hist');\n    cont.textContent = '';\n    $('histWrap').style.display = lista.length ? 'block' : 'none';\n    lista.forEach(function (h) {\n      var fila = el('div', 'hist');\n      fila.appendChild(el('span', 'p ' + (h.semaforo || 'gris')));\n      var t = el('div', 't');\n      t.appendChild(el('div', null, h.nombre || formatear(h.cuit)));\n      t.appendChild(el('div', 'det', formatear(h.cuit) + ' · ' + new Date(h.fecha).toLocaleDateString('es-AR')));\n      fila.appendChild(t);\n      fila.appendChild(el('span', 'e', h.titulo));\n      fila.addEventListener('click', function () { $('cuit').value = formatear(h.cuit); consultar(); });\n      cont.appendChild(fila);\n    });\n  }\n\n  function mostrar(r) {\n    var cont = $('resultado');\n    cont.textContent = '';\n    var sem = r.semaforo || 'gris';\n    var card = el('div', 'res t-' + sem);\n\n    var top = el('div', 'res-top');\n    top.appendChild(el('div', 'semaforo', ICONO[sem] || '?'));\n    var tt = el('div');\n    tt.appendChild(el('h2', null, r.titulo));\n    tt.appendChild(el('div', 'sub', { verde: 'Podés evaluar aceptarlo', amarillo: 'Revisá antes de aceptarlo', rojo: 'No se recomienda aceptarlo', gris: 'Sin información suficiente' }[sem] || ''));\n    top.appendChild(tt);\n    card.appendChild(top);\n\n    var body = el('div', 'res-body');\n    var res = r.resumen || {};\n    if (res.denominacion) body.appendChild(el('div', 'nombre', res.denominacion));\n    body.appendChild(el('div', 'cuit', 'CUIT ' + formatear(r.cuit)));\n    (r.motivos || []).forEach(function (m) {\n      var f = el('div', 'motivo');\n      f.appendChild(el('i', null, '•'));\n      f.appendChild(el('span', null, m));\n      body.appendChild(f);\n    });\n\n    if (res.situacionActual) {\n      body.appendChild(el('div', 'escala-t', 'Situación en el BCRA: ' + (NOMBRES[res.situacionActual] || res.situacionActual)));\n      var esc = el('div', 'escala');\n      [1, 2, 3, 4, 5].forEach(function (n) {\n        var d = el('div', n === res.situacionActual ? 'e-' + (n === 1 ? 'verde' : n === 2 ? 'amarillo' : 'rojo') : '', String(n));\n        esc.appendChild(d);\n      });\n      body.appendChild(esc);\n    }\n\n    if (res.entidades && res.entidades.length) {\n      var b = el('div', 'bloque');\n      b.appendChild(el('b', null, 'Deuda informada (' + res.periodoUltimo + '): ' + pesos(res.deudaTotalMilesARS)));\n      res.entidades.forEach(function (e) {\n        b.appendChild(el('div', 'det', e.entidad + ' · situación ' + e.situacion + ' · ' + pesos(e.monto)));\n      });\n      body.appendChild(b);\n    }\n    if (res.chequesRechazados && res.chequesRechazados.length) {\n      var b2 = el('div', 'bloque');\n      b2.appendChild(el('b', null, 'Cheques rechazados'));\n      res.chequesRechazados.slice(0, 10).forEach(function (q) {\n        var reg = !!q.fechaPago;\n        b2.appendChild(el('div', 'det' + (reg ? '' : ' mal'),\n          'N° ' + q.nroCheque + ' · ' + q.fechaRechazo + ' · ' + pesos(q.monto / 1000) + ' · ' +\n          (reg ? 'regularizado' : 'SIN REGULARIZAR')));\n      });\n      body.appendChild(b2);\n    }\n    if (r.aviso) body.appendChild(el('div', 'aviso', r.aviso));\n    if (typeof r.consultasRestantesHoy === 'number')\n      body.appendChild(el('div', 'aviso', 'Consultas restantes hoy: ' + r.consultasRestantesHoy));\n    card.appendChild(body);\n    cont.appendChild(card);\n    card.scrollIntoView({ behavior: 'smooth', block: 'start' });\n  }\n\n  function consultar() {\n    var cuit = limpiar($('cuit').value);\n    $('error').textContent = '';\n    if (!valido(cuit)) { $('error').textContent = 'El CUIT/CUIL no es válido. Revisá los 11 dígitos.'; return; }\n    var params = new URLSearchParams({ cuit: cuit });\n    if ($('chequeBox').style.display !== 'none') {\n      if ($('banco').value.trim()) params.set('banco', $('banco').value.trim());\n      if ($('cheque').value.trim()) params.set('cheque', $('cheque').value.trim());\n    }\n    var btn = $('buscar');\n    btn.disabled = true; btn.textContent = 'Consultando…';\n    $('resultado').textContent = '';\n    var ctrl = new AbortController();\n    var t = setTimeout(function () { ctrl.abort(); }, 70000); // el plan gratis puede tardar en \"despertar\"\n    fetch('/api/check?' + params.toString(), { signal: ctrl.signal })\n      .then(function (res) {\n        return res.json().catch(function () { return {}; }).then(function (body) {\n          if (!res.ok) throw new Error(body.error || ('Error ' + res.status));\n          return body;\n        });\n      })\n      .then(function (r) { mostrar(r); guardarHist(r); })\n      .catch(function (e) {\n        $('error').textContent = e.name === 'AbortError'\n          ? 'La consulta tardó demasiado. Probá de nuevo.' : (e.message || 'No se pudo consultar.');\n      })\n      .finally(function () { clearTimeout(t); btn.disabled = false; btn.textContent = 'Consultar'; });\n  }\n\n  $('cuit').addEventListener('input', function (e) { e.target.value = formatear(e.target.value); });\n  $('cuit').addEventListener('keydown', function (e) { if (e.key === 'Enter') consultar(); });\n  $('buscar').addEventListener('click', consultar);\n  $('toggle').addEventListener('click', function () {\n    var abierto = $('chequeBox').style.display !== 'none';\n    $('chequeBox').style.display = abierto ? 'none' : 'flex';\n    $('toggle').textContent = abierto ? '+ Verificar si el cheque está denunciado' : '− Ocultar datos del cheque';\n  });\n  $('borrar').addEventListener('click', function () {\n    try { localStorage.removeItem(KEY); } catch (e) {}\n    pintarHist();\n  });\n\n  fetch('/health').then(function (r) { return r.json(); })\n    .then(function (h) { if (h && h.mock) $('demo').style.display = 'block'; })\n    .catch(function () {});\n  pintarHist();\n})();\n</script>\n</body>\n</html>\n";
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
