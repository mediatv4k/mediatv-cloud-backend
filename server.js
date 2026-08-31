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
                console.log('⚡ QR generado listo para escanear');
                qrImageBase64 = await qrcode.toDataURL(qr);
                isConnected = false;
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                console.log(`Estado: Desconectado (${statusCode}). Reconectando: ${shouldReconnect}`);
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
        console.error("Error iniciando socket:", err);
        setTimeout(startWhatsApp, 4000);
    }
}

startWhatsApp();

// Estado general
app.get('/', (req, res) => {
    res.json({
        status: isConnected ? "CONNECTED" : (qrImageBase64 ? "QR_READY" : "STARTING"),
        service: "MediaTV Cloud Bot 24/7"
    });
});

// Pantalla con Auto-Recarga para escanear
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
                <h1 style="color:#22c55e;">✅ WhatsApp ya está vinculado y activo</h1>
                <p>El bot en la nube ya tiene control total para enviar mensajes.</p>
            </div>
        `);
    }

    if (!qrImageBase64) {
        return res.send(`
            <head><meta http-equiv="refresh" content="3"></head>
            <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
                <h2>⏳ Negociando conexión con WhatsApp...</h2>
                <p>Generando código QR. Esta pantalla se recargará sola en 3 segundos.</p>
            </div>
        `);
    }

    res.send(`
        <head><meta http-equiv="refresh" content="20"></head>
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
            <h2 style="margin-bottom:5px;">📱 Escanea con tu WhatsApp</h2>
            <p style="color:#666;margin-top:0;">WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
            <img src="${qrImageBase64}" style="width:320px;height:320px;border:3px solid #000;border-radius:12px;padding:10px;" />
            <p style="font-size:12px;color:#888;">El código se renueva automáticamente cada 20s.</p>
        </div>
    `);
});

// Envío de mensajes
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!isConnected || !sock) {
        return res.status(503).json({ success: false, error: "WhatsApp no conectado." });
    }
    try {
        const cleanPhone = phone.replace(/\D/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, target: cleanPhone });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
