const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
let sock = null;
let qrImageBase64 = null;
let isConnected = false;

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    
    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('⚡ Nuevo código QR generado.');
            qrImageBase64 = await qrcode.toDataURL(qr);
            isConnected = false;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Conexión cerrada. Reconectando: ${shouldReconnect}`);
            isConnected = false;
            if (shouldReconnect) {
                setTimeout(startWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log('✅ ¡WHATSAPP VINCULADO Y LISTO PARA ENVIAR!');
            isConnected = true;
            qrImageBase64 = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startWhatsApp();

// Ruta de estado
app.get('/', (req, res) => {
    res.json({
        status: isConnected ? "CONNECTED" : "WAITING_QR",
        service: "MediaTV Cloud Bot 24/7"
    });
});

// Ruta visual para ver y escanear el QR desde el navegador
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send(`
            <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
                <h1 style="color:green;">✅ WhatsApp ya está vinculado y activo</h1>
                <p>El servidor ya puede enviar mensajes automáticamente.</p>
            </div>
        `);
    }
    if (!qrImageBase64) {
        return res.send(`
            <div style="text-align:center;margin-top:50px;font-family:sans-serif;">
                <h2>⏳ Generando código QR...</h2>
                <p>Por favor, recarga esta página en 5 segundos.</p>
            </div>
        `);
    }
    res.send(`
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;font-family:sans-serif;">
            <h2>📱 Escanea este código QR con tu WhatsApp</h2>
            <p>Abre WhatsApp > Dispositivos vinculados > Vincular un dispositivo</p>
            <img src="${qrImageBase64}" style="width:300px;height:300px;border:2px solid #333;padding:10px;border-radius:10px;" />
        </div>
    `);
});

// Ruta receptora de mensajes
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!isConnected || !sock) {
        return res.status(503).json({ success: false, error: "WhatsApp no está vinculado todavía." });
    }
    try {
        const cleanPhone = phone.replace(/\D/g, '');
        const jid = `${cleanPhone}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        console.log(` Mensaje enviado con éxito a: ${cleanPhone}`);
        res.json({ success: true, target: cleanPhone });
    } catch (err) {
        console.error("Error enviando mensaje:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor activo en puerto ${PORT}`);
});