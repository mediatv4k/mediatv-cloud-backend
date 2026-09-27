const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    initAuthCreds,
    BufferJSON
} = require('@whiskeysockets/baileys');

const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs } = require('firebase/firestore');

// 🛡️ SOP v2.1 (Blindaje 2026-09-27): la config de Firebase ya NO se hardcodea.
// Debe definirse en las variables de entorno del servicio (Render → Environment).
// Ver .env.example para la lista completa y los valores previos como referencia.
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    console.error('❌ Faltan variables de entorno de Firebase (FIREBASE_API_KEY / FIREBASE_PROJECT_ID). Configúralas en Render antes de desplegar. Ver .env.example.');
}

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// CORRECCIÓN: Ahora esta función sí limpia la basura acumulada en la base de datos
async function limpiarSesionesAntiguas() {
    try {
        const querySnapshot = await getDocs(collection(db, 'mediatv_data'));
        const batch = [];
        querySnapshot.forEach((document) => {
            if (document.id.startsWith('wa_session_') && document.id !== 'wa_session_creds') {
                batch.push(deleteDoc(doc(db, 'mediatv_data', document.id)));
            }
        });
        await Promise.all(batch);
    } catch (e) {}
}

async function useFirestoreAuthState() {
    const writeData = async (data, id) => {
        try {
            const jsonString = JSON.stringify(data, BufferJSON.replacer);
            await setDoc(doc(db, 'mediatv_data', `wa_session_${id}`), { data: jsonString });
        } catch (e) {
            addLog(`❌ Error Firestore (writeData ${id}): ${e.message}`, 'error');
        }
    };

    const readData = async (id) => {
        try {
            const snap = await getDoc(doc(db, 'mediatv_data', `wa_session_${id}`));
            if (!snap.exists()) return null;
            return JSON.parse(snap.data().data, BufferJSON.reviver);
        } catch (error) {
            addLog(`❌ Error Firestore (readData ${id}): ${error.message}`, 'error');
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await deleteDoc(doc(db, 'mediatv_data', `wa_session_${id}`));
        } catch (error) {
            addLog(`❌ Error Firestore (removeData ${id}): ${error.message}`, 'error');
        }
    };

    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
    }

    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                for (const id of ids) {
                    data[id] = await readData(`${type}-${id}`);
                }
                return data;
            },
            set: async (data) => {
                const tasks = [];
                for (const category of Object.keys(data)) {
                    for (const id of Object.keys(data[category])) {
                        const value = data[category][id];
                        const keyId = `${category}-${id}`;
                        if (value) tasks.push(writeData(value, keyId));
                        else tasks.push(removeData(keyId));
                    }
                }
                await Promise.all(tasks);
            }
        }
    };

    return {
        state,
        saveCreds: () => writeData(state.creds, 'creds')
    };
}

const app = express();

// 🛡️ SOP v2.1 (Blindaje 2026-09-27): CORS restringido al frontend de producción.
// En desarrollo (NODE_ENV !== 'production') también se acepta localhost para pruebas.
const ORIGENES_PERMITIDOS = ['https://mediatv-4k.vercel.app'];
if (process.env.NODE_ENV !== 'production') {
    ORIGENES_PERMITIDOS.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5500', 'http://127.0.0.1:5500');
}
app.use(cors({
    origin: function (origin, callback) {
        // Peticiones sin Origin (curl, health-checks de Render, la propia página /qr) se permiten:
        // no son navegadores de terceros ejecutando fetch() cross-origin.
        if (!origin || ORIGENES_PERMITIDOS.includes(origin)) return callback(null, true);
        return callback(new Error('Origen no autorizado por CORS'));
    }
}));
app.use(express.json());

// 🛡️ SOP v2.1 (Blindaje 2026-09-27): middleware de autenticación por secreto compartido.
// Exigido en todo POST administrativo y en GET /qr (que expone el código de vinculación).
// El secreto viaja por header `x-api-key` (POST) o querystring `?token=` (GET /qr).
function requireAdminSecret(req, res, next) {
    const secretoConfigurado = process.env.ADMIN_API_SECRET;
    if (!secretoConfigurado) {
        console.error('❌ ADMIN_API_SECRET no está configurado en el entorno: todos los endpoints protegidos devuelven 403.');
        return res.status(403).json({ success: false, error: 'Servidor mal configurado: falta ADMIN_API_SECRET' });
    }
    const recibido = req.get('x-api-key') || req.query.token;
    if (recibido !== secretoConfigurado) {
        return res.status(403).json({ success: false, error: 'Forbidden: secreto inválido o ausente' });
    }
    next();
}

const PORT = process.env.PORT || 10000;
let sock = null;
let qrImageBase64 = null;
let isConnected = false;
let cloudLogs = [];

function getTimestamp() {
    return new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
}

function addLog(msg, type = 'info') {
    const time = getTimestamp();
    cloudLogs.unshift({ time, text: msg, msg, type });
    if (cloudLogs.length > 50) cloudLogs.pop();
}

function getProp(obj, possibleKeys) {
    for (const k of possibleKeys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
        const foundKey = Object.keys(obj).find(ek => ek.toLowerCase() === k.toLowerCase());
        if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null && obj[foundKey] !== '') return obj[foundKey];
    }
    return null;
}

async function ejecutarLogicaBarrido(whatsappClient, origenManual = false) {
    const adminRef = doc(db, 'mediatv_data', 'admin');
    const adminSnap = await getDoc(adminRef);
    
    if (!adminSnap.exists()) return 0;
    const dataAdmin = adminSnap.data();
    const listaClientes = dataAdmin.clientes || [];
    
    const now = new Date();
    const horaActualVE = new Date(now.getTime() - (4 * 60 * 60 * 1000));
    const hoy = new Date(horaActualVE.getFullYear(), horaActualVE.getMonth(), horaActualVE.getDate());
    let enviadosCount = 0;

    addLog(origenManual ? "⚡ [MANUAL] Ejecutando barrido forzado desde el panel..." : "🚀 [BOT] Iniciando barrido automático...", "warning");

    for (const client of listaClientes) {
        const usuario = getProp(client, ['Usuario', 'usuario', 'USUARIO']);
        if (!usuario) continue;

        const nombre = getProp(client, ['Nombre Completo', 'nombreCompleto', 'Nombre', 'nombre', 'NOMBRE']) || 'Cliente';
        const fechaExpStr = getProp(client, ['Fecha Expira', 'fechaExpira', 'Expira', 'expira', 'VENCIMIENTO', 'FECHA_EXPIRA']);
        const telRaw = getProp(client, ['Teléfono', 'telefono', 'Telefono', 'TELEFONO']);
        const password = getProp(client, ['CONTRASEÑA', 'Contraseña', 'password', 'clave', 'Clave']) || '';

        if (!fechaExpStr) continue;
        
        let fechaExp;
        const cleanDate = String(fechaExpStr).trim();
        if (cleanDate.includes('-') && cleanDate.split('-')[0].length === 4) {
            fechaExp = new Date(cleanDate + "T00:00:00");
        } else if (cleanDate.includes('-')) {
            const p = cleanDate.split('-');
            fechaExp = new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00`);
        } else if (cleanDate.includes('/')) {
            const p = cleanDate.split('/');
            fechaExp = new Date(`${p[2]}-${p[1]}-${p[0]}T00:00:00`);
        } else {
            continue;
        }

        if (isNaN(fechaExp.getTime())) continue;

        const diffTime = fechaExp - hoy;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        let mensaje = "";
        let tipoEnvio = "";

        if (diffDays >= 0 && diffDays <= 5) {
            tipoEnvio = "🟡 Por Vencer";
            mensaje = `¡Hola ${nombre}! 👋 Te saluda el *Equipo de Soporte Técnico de MediaTV*.\n\nTe recordamos que tu servicio para el usuario (*${usuario}*) vence el ${fechaExpStr}.\n\n💳 Puedes procesar tu renovación rápida y segura aquí:\nhttps://mediatv-4k.vercel.app/pay/${usuario}\n\n📺 *Tus Datos de Acceso (Guárdalos bien):*\n👤 *Usuario:* ${usuario}\n🔑 *Contraseña:* ${password}\n\n¡Mantén tu entretenimiento en 4K activo al instante! ✨`;
        } else if (diffDays < 0 && Math.abs(diffDays) <= 5) {
            const diasVencido = Math.abs(diffDays);
            tipoEnvio = "🔴 Vencido Reciente";
            mensaje = `¡Hola ${nombre}! 👋 Te saluda el *Equipo de Soporte Técnico de MediaTV*.\n\nTe informamos que tu servicio para el usuario (*${usuario}*) venció hace ${diasVencido} día(s) (el ${fechaExpStr}). ⚠️\n\n💳 Puedes procesar tu renovación rápida y segura aquí:\nhttps://mediatv-4k.vercel.app/pay/${usuario}\n\n📺 *Tus Datos de Acceso (Guárdalos bien):*\n👤 *Usuario:* ${usuario}\n🔑 *Contraseña:* ${password}\n\n¡Reactiva tu entretenimiento en 4K al instante! ✨`;
        }

        if (mensaje && telRaw) {
            let telefono = String(telRaw).replace(/\D/g, '');
            if (telefono.length >= 10) {
                const jid = telefono + "@s.whatsapp.net";
                await whatsappClient.sendMessage(jid, { text: mensaje });
                enviadosCount++;
                addLog(`✅ Cobro [${tipoEnvio}] enviado a ${nombre} (Usuario: ${usuario})`, "success");
                await new Promise(r => setTimeout(r, 4000));
            }
        }
    }
    addLog(`🎯 Barrido finalizado. Total notificaciones enviadas: ${enviadosCount}`, "success");
    return enviadosCount;
}

let botInterval = null;
let ultimoMinutoProcesado = -1;
let ultimoDiaProcesado = ""; 

function matchesScheduledTime(horaProg, currentHours24, currentMinutes) {
    if (!horaProg) return false; 
    const clean = String(horaProg).toLowerCase().replace(/\s+/g, '').trim();
    
    if (/^\d{1,2}:\d{2}$/.test(clean)) {
        const [h, m] = clean.split(':').map(Number);
        return currentHours24 === h && currentMinutes === m;
    }
    
    const match = clean.match(/(\d{1,2}):(\d{2})/);
    if (match) {
        let h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        
        if (clean.includes('p') && h < 12) h += 12;
        if (clean.includes('a') && h === 12) h = 0;
        
        return currentHours24 === h && currentMinutes === m;
    }
    return false;
}

function iniciarMotorCobranzaCloud(whatsappClient) {
    if (botInterval) clearInterval(botInterval); 
    addLog("🤖 Cerebro Cloud 24/7 sincronizado con control absoluto del panel...", "success");

    botInterval = setInterval(async () => {
        try {
            const now = new Date();
            const horaActualVE = new Date(now.getTime() - (4 * 60 * 60 * 1000));
            const currentHours24 = horaActualVE.getHours();
            const minutoActual = horaActualVE.getMinutes();
            const claveMinutoUnica = `${currentHours24}-${minutoActual}`;
            
            const anio = horaActualVE.getFullYear();
            const mes = String(horaActualVE.getMonth() + 1).padStart(2, '0');
            const dia = String(horaActualVE.getDate()).padStart(2, '0');
            const hoyStr = `${anio}-${mes}-${dia}`;
            
            const adminRef = doc(db, 'mediatv_data', 'admin');
            const adminSnap = await getDoc(adminRef);
            
            if (!adminSnap.exists()) return;
            const dataAdmin = adminSnap.data();
            const horaProgramadaPanel = dataAdmin.horaProgramada || (dataAdmin.botConfig && dataAdmin.botConfig.hour);
            const estadoEnvio = dataAdmin.estadoEnvio || "Activo";

            if (estadoEnvio === "Pausado") return;

            const esHoraDeCobro = matchesScheduledTime(horaProgramadaPanel, currentHours24, minutoActual);

            if (esHoraDeCobro && ultimoMinutoProcesado !== claveMinutoUnica && ultimoDiaProcesado !== hoyStr) {
                ultimoMinutoProcesado = claveMinutoUnica;
                ultimoDiaProcesado = hoyStr; 
                await ejecutarLogicaBarrido(whatsappClient, false);
            }
        } catch (error) {
            addLog(`❌ [BOT ERROR] ${error.message}`, "error");
        }
    }, 20000);
}

addLog("🟢 Servidor Cloud iniciado con control de panel", "success");

async function startWhatsApp() {
    try {
        await limpiarSesionesAntiguas();
        const { state, saveCreds } = await useFirestoreAuthState();
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: { creds: state.creds, keys: state.keys },
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            markOnlineOnConnect: false
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrImageBase64 = await qrcode.toDataURL(qr, { margin: 1, width: 260 });
                isConnected = false;
                addLog("⚡ QR Generado, esperando escaneo...", "warning");
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                isConnected = false;
                addLog(`⚠️ Conexión en espera...`, "warning");
                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                qrImageBase64 = null;
                addLog("✅ WhatsApp vinculado", "success");
                iniciarMotorCobranzaCloud(sock);
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        addLog(`❌ Error socket: ${err.message}`, "error");
        setTimeout(startWhatsApp, 4000);
    }
}

startWhatsApp();

// NUEVO ENDPOINT DE EMERGENCIA: Limpia la sesión corrupta desde el panel frontal
app.post(['/api/reset-whatsapp', '/reset-whatsapp'], requireAdminSecret, async (req, res) => {
    try {
        addLog("♻️ Orden de reseteo recibida. Borrando caché...", "warning");
        const querySnapshot = await getDocs(collection(db, 'mediatv_data'));
        const tasks = [];
        querySnapshot.forEach((document) => {
            if (document.id.startsWith('wa_session_')) {
                tasks.push(deleteDoc(doc(db, 'mediatv_data', document.id)));
            }
        });
        await Promise.all(tasks);
        
        qrImageBase64 = null;
        isConnected = false;
        
        if (sock) {
            try { sock.logout(); } catch(e){}
            sock = null;
        }
        
        addLog("🗑️ Caché eliminado. Reiniciando núcleo de WhatsApp...", "info");
        setTimeout(startWhatsApp, 2000);
        res.json({ success: true, message: "Reinicio profundo en proceso" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post(['/settings', '/api/settings', '/api/admin-config', '/admin-config'], requireAdminSecret, async (req, res) => {
    try {
        const horaProgramada = req.body.horaProgramada || req.body.hour || "";
        const estadoEnvio = req.body.estadoEnvio || req.body.status || "Activo";
        const adminRef = doc(db, 'mediatv_data', 'admin');
        await setDoc(adminRef, { horaProgramada: horaProgramada, estadoEnvio: estadoEnvio }, { merge: true });
        addLog(`⚙️ Hora configurada desde el panel: ${horaProgramada}`, "success");
        res.json({ success: true, message: "OK" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post(['/api/forzar-barrido', '/forzar-barrido'], requireAdminSecret, async (req, res) => {
    try {
        if (!sock || !isConnected) {
            return res.status(400).json({ success: false, error: "WhatsApp no está conectado en la nube." });
        }
        const totalEnviados = await ejecutarLogicaBarrido(sock, true);
        res.json({ success: true, message: "Barrido forzado ejecutado con éxito", enviados: totalEnviados });
    } catch (e) {
        addLog(`❌ Error en barrido forzado: ${e.message}`, "error");
        res.status(500).json({ success: false, error: e.message });
    }
});

// 🛡️ SOP v2.1 (Blindaje 2026-09-27): endpoint huérfano implementado. El frontend
// (js/auth.js: mensaje de bienvenida al crear cuenta; js/ui.js: botón "Probar
// Envío Real" de Configuración) ya llamaba a esta ruta, que no existía.
app.post(['/api/enviar-notificacion'], requireAdminSecret, async (req, res) => {
    try {
        const telefono = req.body && req.body.telefono;
        const mensaje = req.body && req.body.mensaje;
        if (!telefono || !mensaje) {
            return res.status(400).json({ success: false, error: "Faltan 'telefono' o 'mensaje' en el body" });
        }
        if (!sock || !isConnected) {
            return res.status(503).json({ success: false, error: "WhatsApp no está conectado en la nube." });
        }
        const telefonoLimpio = String(telefono).replace(/\D/g, '');
        if (telefonoLimpio.length < 10) {
            return res.status(400).json({ success: false, error: "Número de teléfono inválido" });
        }
        const jid = telefonoLimpio.endsWith('@s.whatsapp.net') ? telefonoLimpio : `${telefonoLimpio}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: String(mensaje) });
        addLog(`✅ Notificación manual enviada a ${telefonoLimpio}`, "success");
        res.json({ success: true, message: "Notificación enviada" });
    } catch (e) {
        addLog(`❌ Error en enviar-notificacion: ${e.message}`, "error");
        res.status(500).json({ success: false, error: e.message });
    }
});

// 🛡️ SOP v2.1 (Cierre de blindaje 2026-09-27): sellado total, sin excepción para
// '/' — ver el aviso de riesgo operativo sobre el health-check de Render en el
// reporte entregado junto con este cambio.
app.get(['/', '/status', '/api/status'], requireAdminSecret, (req, res) => {
    res.json({
        status: isConnected ? "CONNECTED" : (qrImageBase64 ? "QR_READY" : "STARTING"),
        service: "MediaTV Cloud Bot 24/7",
        connected: isConnected
    });
});

app.get(['/logs', '/api/logs'], requireAdminSecret, (req, res) => {
    res.json({ success: true, logs: cloudLogs });
});

app.get('/qr', requireAdminSecret, (req, res) => {
    if (isConnected) {
        return res.send(`<h2 style="font-family:sans-serif;text-align:center;color:green;margin-top:20vh;">✅ WhatsApp Vinculado Exitosamente</h2>`);
    }
    if (!qrImageBase64) {
        return res.send(`<h2 style="font-family:sans-serif;text-align:center;color:#38bdf8;margin-top:20vh;">⏳ Iniciando núcleo de WhatsApp...</h2>`);
    }
    res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5"></head><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#060a12;"><img src="${qrImageBase64}" style="width:250px;height:250px;border-radius:12px;box-shadow:0 0 15px rgba(0,159,227,0.5);" /></body></html>`);
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});