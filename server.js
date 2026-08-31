const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
let sock;
let qrCodeData = null;
let isConnected = false;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrCodeData = await qrcode.toDataURL(qr);
            isConnected = false;
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            isConnected = false;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp conectado exitosamente!');
            isConnected = true;
            qrCodeData = null;
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

// Ruta de estado
app.get('/', (req, res) => {
    res.json({
        status: isConnected ? "CONNECTED" : "WAITING_QR",
        service: "MediaTV Cloud Bot 24/7",
        qr: qrCodeData
    });
});

// Ruta para ver el QR directamente en el navegador
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">✅ WhatsApp ya está vinculado y activo.</h2>');
    }
    if (!qrCodeData) {
        return res.send('<h2 style="font-family:sans-serif;text-align:center;margin-top:50px;">⏳ Generando código QR, recarga en 5 segundos...</h2>');
    }
    res.send(`<div style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;font-family:sans-serif;">
        <h2>Escanea este QR con tu WhatsApp</h2>
        <img src="${qrCodeData}" style="width:300px;height:300px;border:1px solid #ccc;padding:10px;border-radius:8px;" />
    </div>`);
});

// Ruta para enviar mensajes
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!isConnected) {
        return res.status(503).json({ error: "WhatsApp no está conectado todavía." });
    }
    try {
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        res.json({ success: true, target: phone });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en el puerto ${PORT}`);
});