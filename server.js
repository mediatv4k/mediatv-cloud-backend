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

addLog("🟢 Motor Cloud MediaTV iniciado", "success");

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
                addLog("⚡ QR listo en espera de escaneo", "warning");
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                isConnected = false;
                addLog(`⚠️ Conexión en espera (${statusCode || 'Reintentando'})...`, "warning");
                if (shouldReconnect) setTimeout(startWhatsApp, 3000);
            } else if (connection === 'open') {
                isConnected = true;
                qrImageBase64 = null;
                addLog("✅ WhatsApp vinculado y autenticado", "success");
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        addLog(`❌ Error socket: ${err.message}`, "error");
        setTimeout(startWhatsApp, 4000);
    }
}

startWhatsApp();

app.get(['/', '/status'], (req, res) => {
    res.json({ status: isConnected ? "CONNECTED" : (qrImageBase64 ? "QR_READY" : "STARTING"), connected: isConnected });
});

app.get('/logs', (req, res) => {
    res.json({ success: true, logs: cloudLogs });
});

app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#060a12;color:#22c55e;font-family:sans-serif;text-align:center;">
                <div style="font-size:45px;margin-bottom:8px;">✅</div>
                <div style="font-size:16px;font-weight:800;">WhatsApp Vinculado</div>
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

// Opción 3: Diagnóstico rápido por URL
app.get('/test', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.send('Agrega tu número al enlace: /test?phone=58412XXXXXXX');
    try {
        await sendWhatsAppMessage(phone, "🔔 *MediaTV 4K Test:* ¡Conexión con el Servidor Cloud 24/7 establecida con éxito!");
        res.send(`✅ Mensaje de prueba enviado exitosamente al número ${phone}. Revisa tu WhatsApp.`);
    } catch (err) {
        res.send(`❌ Error al enviar prueba: ${err.message}`);
    }
});

// Receptor masivo
app.post(['/send-message', '/send', '/api/send', '/webhook'], async (req, res) => {
    const data = req.body;
    try {
        if (data.phone && data.message) {
            const target = await sendWhatsAppMessage(data.phone, data.message);
            return res.json({ success: true, count: 1, targets: [target] });
        }

        const list = Array.isArray(data) ? data : (data.clients || data.queue || data.numbers || []);
        if (list.length > 0) {
            let sentCount = 0;
            addLog(`🚀 Iniciando lote de cobro para ${list.length} clientes...`, "info");
            for (const item of list) {
                const phone = item.phone || item.telefono || item.numero;
                const msg = item.message || item.mensaje || data.message || "Recordatorio MediaTV 4K";
                if (phone) {
                    await sendWhatsAppMessage(phone, msg);
                    sentCount++;
                    await new Promise(r => setTimeout(r, 2500));
                }
            }
            addLog(`🎯 Lote finalizado: ${sentCount} mensajes enviados`, "success");
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
