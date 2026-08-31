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

// ==========================================
// 1. CONFIGURACIÓN DE FIREBASE
// ==========================================
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, deleteDoc, collection, getDocs } = require('firebase/firestore');

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

async function limpiarSesionesAntiguas() {
    try {
        const querySnapshot = await getDocs(collection(db, 'mediatv_data'));
        querySnapshot.forEach((document) => {
            if (document.id.startsWith('wa_session_') && document.id !== 'wa_session_creds') {}
        });
    } catch (e) {}
}

async function useFirestoreAuthState() {
    const writeData = async (data, id) => {
        try {
            const jsonString = JSON.stringify(data, BufferJSON.replacer);
            await setDoc(doc(db, 'mediatv_data', `wa_session_${id}`), { data: jsonString });
        } catch (e) {}
    };

    const readData = async (id) => {
        try {
            const snap = await getDoc(doc(db, 'mediatv_data', `wa_session_${id}`));
            if (!snap.exists()) return null;
            return JSON.parse(snap.data().data, BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await deleteDoc(doc(db, 'mediatv_data', `wa_session_${id}`));
        } catch (error) {}
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

function getProp(obj, possibleKeys) {
    for (const k of possibleKeys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
        const foundKey = Object.keys(obj).find(ek => ek.toLowerCase() === k.toLowerCase());
        if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null && obj[foundKey] !== '') return obj[foundKey];
    }
    return null;
}

// ==========================================
// 3. CEREBRO DE COBRANZA BLINDADO CON EL "USUARIO" COMO ID ÚNICO
// ==========================================
let botInterval = null;
let ultimoMinutoProcesado = -1;

function matchesScheduledTime(horaProg, currentHours24, currentMinutes) {
    if (!horaProg) return currentMinutes === 0 || currentMinutes === 30;
    const clean = String(horaProg).toLowerCase().trim();
    
    if (/^\d{1,2}:\d{2}$/.test(clean)) {
        const [h, m] = clean.split(':').map(Number);
        return currentHours24 === h && currentMinutes === m;
    }
    
    const match = clean.match(/(\d{1,2}):(\d{2})\s*(a|p)/);
    if (match) {
        let h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        const isPm = match[3] === 'p';
        if (isPm && h < 12) h += 12;
        if (!isPm && h === 12) h = 0;
        return currentHours24 === h && currentMinutes === m;
    }
    return currentMinutes === 0 || currentMinutes === 30;
}

function iniciarMotorCobranzaCloud(whatsappClient) {
    if (botInterval) clearInterval(botInterval); 
    addLog("🤖 Cerebro Cloud 24/7 sincronizado con el ID de Usuario activo...", "success");

    botInterval = setInterval(async () => {
        try {
            const now = new Date();
            const horaActualVE = new Date(now.getTime() - (4 * 60 * 60 * 1000));
            const currentHours24 = horaActualVE.getHours();
            const minutoActual = horaActualVE.getMinutes();
            const claveMinutoUnica = `${currentHours24}-${minutoActual}`;
            
            const adminRef = doc(db, 'mediatv_data', 'admin');
            const adminSnap = await getDoc(adminRef);
            
            if (!adminSnap.exists()) return;
            const dataAdmin = adminSnap.data();
            
            // LECTURA INTELIGENTE: Soporta tanto horaProgramada como botConfig.hour
            const horaProgramadaPanel = dataAdmin.horaProgramada || (dataAdmin.botConfig && dataAdmin.botConfig.hour);

            const esHoraDeCobro = matchesScheduledTime(horaProgramadaPanel, currentHours24, minutoActual);

            if (esHoraDeCobro && ultimoMinutoProcesado !== claveMinutoUnica) {
                ultimoMinutoProcesado = claveMinutoUnica;
                const horaStrVE = String(currentHours24).padStart(2, '0') + ":" + String(minutoActual).padStart(2, '0');
                addLog(`🚀 [BOT] Barrido inteligente activado a las ${horaStrVE} (VE)...`, "warning");
                
                const listaClientes = dataAdmin.clientes || [];
                const hoy = new Date(horaActualVE.getFullYear(), horaActualVE.getMonth(), horaActualVE.getDate());
                let enviadosCount = 0;

                for (const client of listaClientes) {
                    const usuario = getProp(client, ['USUARIO', 'Usuario', 'usuario']);
                    if (!usuario) continue;

                    const nombre = getProp(client, ['NOMBRE', 'Nombre Completo', 'nombreCompleto', 'Nombre', 'nombre']) || 'Cliente';
                    const fechaExpStr = getProp(client, ['FECHA_EXPIRA', 'fecha_expira', 'Fecha Expira', 'Expira', 'expira', 'VENCIMIENTO']);
                    const telRaw = getProp(client, ['TELEFONO', 'Teléfono', 'Telefono', 'telefono']);

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
                        mensaje = `¡Hola ${nombre}! 🤝 Te saluda el *Equipo de Soporte de MediaTV*.\n\nTe recordamos que tu servicio para el usuario (*${usuario}*) vence en ${diffDays === 0 ? 'HOY' : diffDays + ' día(s)'}. ⏳\n\n💳 Puedes procesar tu renovación rápida y segura en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${usuario}`;
                    } else if (diffDays < 0 && Math.abs(diffDays) <= 5) {
                        const diasVencido = Math.abs(diffDays);
                        tipoEnvio = "🔴 Vencido Reciente";
                        mensaje = `¡Hola ${nombre}! ⚠️ Te saluda el *Equipo de Soporte de MediaTV*.\n\nNotamos que tu suscripción para el usuario (*${usuario}*) venció hace ${diasVencido} día(s). 🔴\n\n✨ ¡Reactiva tu cuenta al instante en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${usuario}`;
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
                addLog(`🎯 Barrido finalizado. Total cobros despachados: ${enviadosCount}`, "success");
            }
        } catch (error) {
            addLog(`❌ [BOT ERROR] ${error.message}`, "error");
        }
    }, 20000);
}

// ==========================================
// 4. MOTOR DE WHATSAPP
// ==========================================
addLog("🟢 Servidor Cloud 24/7 iniciado con éxito", "success");

async function startWhatsApp() {
    try {
        await limpiarSesionesAntiguas();
        const { state, saveCreds } = await useFirestoreAuthState();
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: state.keys
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
                addLog("✅ WhatsApp vinculado y autenticado correctamente en la Nube", "success");
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
app.post(['/settings', '/api/settings'], async (req, res) => {
    try {
        const { horaProgramada, estadoEnvio } = req.body;
        const adminRef = doc(db, 'mediatv_data', 'admin');
        await setDoc(adminRef, { 
            horaProgramada: horaProgramada || "",
            estadoEnvio: estadoEnvio || "Activo"
        }, { merge: true });
        addLog(`⚙️ Configuración actualizada desde el panel: Hora -> ${horaProgramada}`, "success");
        res.json({ success: true, message: "Settings guardados con éxito" });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

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
                <div style="font-size:16px;font-weight:800;letter-spacing:0.5px;">WhatsApp Vinculado Exitosamente</div>
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
                <div style="font-size:14px;font-weight:700;">Servidor operando con normalidad...</div>
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

app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
```[cite: 8]
