const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers
} = require('@whiskeysockets/baileys');

// ==========================================
// 1. CONFIGURACIÓN DE FIREBASE (LLAVES INTEGRADAS)
// ==========================================
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');

const firebaseConfig = {
    apiKey: "AIzaSyCebbQ6exTiSQVsQk6Ub4hNZTZI0fNpxK8",
    authDomain: "mediatv4k-30eb0.firebaseapp.com",
    projectId: "mediatv4k-30eb0",
    storageBucket: "mediatv4k-30eb0.firebasestorage.app",
    messagingSenderId: "768500262681",
    appId: "1:768500262681:web:9795dd138f947503e08788"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ==========================================
// 2. INICIALIZACIÓN DEL SERVIDOR WEB
// ==========================================
const app = express();
app.use(cors());
app.use(express.json());

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
    cloudLogs.unshift({ time, msg, type });
    if (cloudLogs.length > 50) cloudLogs.pop();
}

// Búsqueda inteligente e insensible a mayúsculas/acentos para evitar fallos
function getProp(obj, possibleKeys) {
    for (const k of possibleKeys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
        const foundKey = Object.keys(obj).find(ek => ek.toLowerCase() === k.toLowerCase());
        if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null && obj[foundKey] !== '') return obj[foundKey];
    }
    return null;
}

// ==========================================
// 3. CEREBRO: BOT DE COBRANZA CLOUD 24/7 (BARRIDO AUTOMÁTICO CADA HORA EN :00 y :30)
// ==========================================
let botInterval = null;
let ultimoMinutoProcesado = -1;

function iniciarMotorCobranzaCloud(whatsappClient) {
    if (botInterval) clearInterval(botInterval); 
    addLog("🤖 Cerebro Cloud 24/7 con escaneo inteligente de cartera...", "success");

    botInterval = setInterval(async () => {
        try {
            const now = new Date();
            const horaActualVE = new Date(now.getTime() - (4 * 60 * 60 * 1000));
            const minutoActual = horaActualVE.getMinutes();
            const horaStr = String(horaActualVE.getHours()).padStart(2, '0') + ":" + String(minutoActual).padStart(2, '0');
            
            const esHoraDeCobro = (minutoActual === 0 || minutoActual === 30);

            if (esHoraDeCobro && ultimoMinutoProcesado !== minutoActual) {
                ultimoMinutoProcesado = minutoActual;
                addLog(`🚀 [BOT] Iniciando barrido inteligente de cartera a las ${horaStr} (VE)...`, "warning");
                
                const adminRef = doc(db, 'mediatv_data', 'admin');
                const adminSnap = await getDoc(adminRef);
                
                if (!adminSnap.exists()) {
                    addLog(`❌ [BOT ERROR] No se encontró el documento admin en Firestore`, "error");
                    return;
                }

                const dataAdmin = adminSnap.data();
                const listaClientes = dataAdmin.clientes || [];
                
                const hoy = new Date();
                hoy.setHours(0, 0, 0, 0);
                let enviadosCount = 0;

                for (const client of listaClientes) {
                    const nombre = getProp(client, ['Nombre', 'nombre']) || 'Cliente';
                    const usuario = getProp(client, ['Usuario', 'usuario']) || 'N/A';
                    const fechaExpStr = getProp(client, ['Expira', 'expira', 'Fecha Expira', 'VENCIMIENTO']);
                    const telRaw = getProp(client, ['Teléfono', 'telefono', 'Telefono', 'TELEFONO']);

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

                    // Regla: 0 a 5 días por vencer, o vencido hace 1 a 5 días
                    if (diffDays >= 0 && diffDays <= 5) {
                        tipoEnvio = "🟡 Por Vencer";
                        mensaje = `¡Hola ${nombre}! 🤝 Te saluda el *Equipo de Soporte de MediaTV*.\n\nTe recordamos que tu servicio para el usuario (*${usuario}*) vence en ${diffDays === 0 ? 'HOY' : diffDays + ' día(s)'}. ⏳\n\n💳 Puedes procesar tu renovación rápida y segura en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${usuario}`;
                    } else if (diffDays < 0 && Math.abs(diffDays) <= 5) {
                        const diasVencido = Math.abs(diffDays);
                        tipoEnvio = "🔴 Vencido Reciente";
                        mensaje = `¡Hola ${nombre}! ⚠️ Te saluda el *Equipo de Soporte de MediaTV*.\n\nNotamos que tu suscripción para el usuario (*${usuario}*) venció hace ${diasVencido} día(s). 🔴\n\n✨ ¡No te quedes sin tu entretenimiento! Reactiva tu cuenta al instante en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${usuario}`;
                    }

                    if (mensaje && telRaw) {
                        let telefono = String(telRaw).replace(/\D/g, '');
                        if (telefono.length >= 10) {
                            const jid = telefono + "@s.whatsapp.net";
                            await whatsappClient.sendMessage(jid, { text: mensaje });
                            enviadosCount++;
                            addLog(`✅ Cobro [${tipoEnvio}] enviado a ${nombre} (${telefono})`, "success");
                            await new Promise(r => setTimeout(r, 4000));
                        }
                    }
                }
                addLog(`🎯 Barrido inteligente finalizado. Total cobros despachados: ${enviadosCount}`, "success");
            }
        } catch (error) {
            addLog(`❌ [BOT ERROR] ${error.message}`, "error");
            console.error(error);
        }
    }, 20000);
}

// ==========================================
// 4. MOTOR DE WHATSAPP (BAILEYS)
// ==========================================
addLog("🟢 Servidor Cloud 24/7 iniciado con éxito", "success");

async function startWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_session');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
            },
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
                addLog("⚡ Código QR generado en espera de escaneo", "warning");
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                isConnected = false;
                addLog(`⚠️ Conexión en espera (${statusCode || 'Reintentando'})...`, "warning");
                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                isConnected = true;
                qrImageBase64 = null;
                addLog("✅ WhatsApp vinculado y autenticado correctamente", "success");
                
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

// ==========================================
// 5. ENDPOINTS Y RUTAS EXPRESS
// ==========================================
app.get(['/', '/status', '/api/status'], (req, res) => {
    res.json({
        status: isConnected ? "CONNECTED" : (qrImageBase64 ? "QR_READY" : "STARTING"),
        service: "MediaTV Cloud Bot 24/7",
        connected: isConnected
    });
});

app.get(['/logs', '/api/logs'], (req, res) => {
    res.json({ success: true, logs: cloudLogs });
});

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#060a12;color:#22c55e;font-family:sans-serif;text-align:center;">
                <div style="font-size:45px;margin-bottom:8px;">✅</div>
                <div style="font-size:16px;font-weight:800;letter-spacing:0.5px;">WhatsApp Vinculado</div>
                <div style="font-size:12px;color:#94a3b8;margin-top:4px;">Servidor Cloud 24/7 Activo</div>
            </body>
            </html>
        `);
    }

    if (!qrImageBase64) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head><meta http-equiv="refresh" content="3"></head>
            <body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#060a12;color:#38bdf8;font-family:sans-serif;text-align:center;">
                <div style="font-size:30px;margin-bottom:8px;">⏳</div>
                <div style="font-size:14px;font-weight:700;">Generando código QR...</div>
            </body>
            </html>
        `);
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head><meta http-equiv="refresh" content="20"></head>
        <body style="margin:0;padding:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#ffffff;overflow:hidden;">
            <img src="${qrImageBase64}" style="width:250px;height:250px;object-fit:contain;display:block;" />
        </body>
        </html>
    `);
});

async function sendWhatsAppMessage(phone, message) {
    if (!isConnected || !sock) throw new Error("WhatsApp no está conectado.");
    const cleanPhone = String(phone).replace(/\D/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    addLog(`📩 Mensaje entregado a: ${cleanPhone}`, "success");
    return cleanPhone;
}

app.post(['/send-message', '/send', '/api/send', '/webhook', '/api/webhook'], async (req, res) => {
    const data = req.body;
    try {
        if (data.phone && data.message) {
            const target = await sendWhatsAppMessage(data.phone, data.message);
            return res.json({ success: true, count: 1, targets: [target] });
        }

        const list = Array.isArray(data) ? data : (data.clients || data.queue || data.numbers || []);
        if (list.length > 0) {
            let sentCount = 0;
            for (const item of list) {
                const phone = item.phone || item.telefono || item.numero;
                const msg = item.message || item.mensaje || data.message || "Recordatorio MediaTV 4K";
                if (phone) {
                    await sendWhatsAppMessage(phone, msg);
                    sentCount++;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
            return res.json({ success: true, count: sentCount });
        }
        res.status(400).json({ error: "No se encontraron números válidos." });
    } catch (err) {
        addLog(`❌ Error en envío: ${err.message}`, "error");
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
