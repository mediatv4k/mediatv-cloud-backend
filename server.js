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
                qrImageBase64 = await qrcode.toDataURL(qr);
                isConnected = false;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                isConnected = false;
                if (shouldReconnect) {
                    setTimeout(startWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                console.log('✅ ¡WHATSAPP VINCULADO CON ÉXITO!');
                isConnected = true;
                qrImageBase64 = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (err) {
        console.error("Error socket:", err);
        setTimeout(startWhatsApp, 4000);
    }
}

startWhatsApp();

// Estado general para el panel
app.get(['/', '/status', '/api/status'], (req, res) => {
    res.json({
        status: isConnected ? "CONNECTED" : (qrImageBase64 ? "QR_READY" : "STARTING"),
        service: "MediaTV Cloud Bot 24/7",
        connected: isConnected
    });
});

// Pantalla QR
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;color:#22c55e;margin-top:50px;">✅ WhatsApp ya está vinculado y activo</h2>');
    }
    if (!qrImageBase64) {
        return res.send('<head><meta http-equiv="refresh" content="3"></head><h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">⏳ Generando código QR...</h2>');
    }
    res.send(`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
        <h2>📱 Escanea con tu WhatsApp</h2>
        <img src="${qrImageBase64}" style="width:300px;height:300px;border:2px solid #000;border-radius:10px;padding:10px;" />
    </div>`);
});

// Función central para despachar un mensaje
async function sendWhatsAppMessage(phone, message) {
    if (!isConnected || !sock) throw new Error("WhatsApp no está conectado.");
    const cleanPhone = String(phone).replace(/\D/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`📩 [ENVIADO] Mensaje entregado a: ${cleanPhone}`);
    return cleanPhone;
}

// Receptor Universal: Atrapa envíos individuales o listas masivas
app.post(['/send-message', '/send', '/api/send', '/webhook', '/api/webhook'], async (req, res) => {
    console.log("📥 Petición recibida en el backend:", JSON.stringify(req.body));
    const data = req.body;

    try {
        // Caso 1: Envío de cliente individual
        if (data.phone && data.message) {
            const target = await sendWhatsAppMessage(data.phone, data.message);
            return res.json({ success: true, count: 1, targets: [target] });
        }

        // Caso 2: Envío de lista/lote de clientes
        const list = Array.isArray(data) ? data : (data.clients || data.queue || data.numbers || []);
        if (list.length > 0) {
            let sentCount = 0;
            for (const item of list) {
                const phone = item.phone || item.telefono || item.numero;
                const msg = item.message || item.mensaje || data.message || "Recordatorio de MediaTV 4K";
                if (phone) {
                    await sendWhatsAppMessage(phone, msg);
                    sentCount++;
                    await new Promise(r => setTimeout(r, 2000)); // Pausa de 2s antispam
                }
            }
            return res.json({ success: true, count: sentCount });
        }

        res.status(400).json({ error: "No se encontraron números válidos en la petición." });
    } catch (err) {
        console.error("❌ Error al procesar envío:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
