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

let botInterval = null;
let ultimoMinutoProcesado = -1;

function matchesScheduledTime(horaProg, currentHours24, currentMinutes) {
    if (!horaProg) return currentMinutes === 0;
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
    return currentMinutes === 0;
}

function iniciarMotorCobranzaCloud(whatsappClient) {
    if (botInterval) clearInterval(botInterval); 
    addLog("🤖 Cerebro Cloud 24/7 sincronizado...", "success");

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
            const horaProgramadaPanel = dataAdmin.horaProgramada || (dataAdmin.botConfig && dataAdmin.botConfig.hour);

            const esHoraDeCobro = matchesScheduledTime(horaProgramadaPanel, currentHours24, minutoActual);

            if (esHoraDeCobro && ultimoMinutoProcesado !== claveMinutoUnica) {
                ultimoMinutoProcesado = claveMinutoUnica;
                const horaStrVE = String(currentHours24).padStart(2, '0') + ":" + String(minutoActual).padStart(2, '0');
                addLog(`🚀 [BOT] Barrido activado a las ${horaStrVE} (VE)...`, "warning");
                
                const listaClientes = dataAdmin.clientes || [];
                const hoy = new Date(horaActualVE.getFullYear(), horaActualVE.getMonth(), horaActualVE.getDate());
                let enviadosCount = 0;

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
                        mensaje = `¡Hola ${nombre}! 👋 Te escribimos de MediaTV 4K.\n\nTu servicio para el usuario (${usuario}) está próximo a vencer en ${diffDays === 0 ? 'HOY' : diffDays + ' día(s)'} (Vence el: ${fechaExpStr}). 🚨\n\n💳 Evita interrupciones pagando directo en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${usuario}\n\n📺 Tus Datos de Acceso:\n👤 Usuario: ${usuario}\n🔑 Contraseña: ${password}`;
                    } else if (diffDays < 0 && Math.abs(diffDays) <= 5) {
                        const diasVencido = Math.abs(diffDays);
                        tipoEnvio = "🔴 Vencido Reciente";
                        mensaje = `¡Hola ${nombre}! 👋 Te escribimos de MediaTV 4K.\n\nTu servicio para el usuario (${usuario}) venció hace ${diasVencido} día(s) (Venció el: ${fechaExpStr}). 🚨\n\n💳 Reactiva tu cuenta pagando directo en nuestra taquilla virtual:\nhttps://mediatv-4k.vercel.app/pay/${usuario}\n\n📺 Tus Datos de Acceso:\n👤 Usuario: ${usuario}\n🔑 Contraseña: ${password}`;
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
                addLog(`🎯 Barrido finalizado. Total: ${enviadosCount}`, "success");
            }
        } catch (error) {
            addLog(`❌ [BOT ERROR] ${error.message}`, "error");
        }
    }, 20000);
}

addLog("🟢 Servidor Cloud iniciado", "success");

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
                addLog("⚡ QR Generado", "warning");
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

app.post(['/settings', '/api/settings'], async (req, res) => {
    try {
        const { horaProgramada, estadoEnvio } = req.body;
        const adminRef = doc(db, 'mediatv_data', 'admin');
        await setDoc(adminRef, { 
            horaProgramada: horaProgramada || "",
            estadoEnvio: estadoEnvio || "Activo"
        }, { merge: true });
        addLog(`⚙️ Hora configurada: ${horaProgramada}`, "success");
        res.json({ success: true, message: "OK" });
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
        return res.send(`<h2 style="font-family:sans-serif;text-align:center;color:green;margin-top:20vh;">✅ WhatsApp Vinculado Exitosamente</h2>`);
    }
    if (!qrImageBase64) {
        return res.send(`<h2 style="font-family:sans-serif;text-align:center;color:#38bdf8;margin-top:20vh;">⏳ Iniciando...</h2>`);
    }
    res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="20"></head><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#fff;"><img src="${qrImageBase64}" style="width:250px;height:250px;" /></body></html>`);
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
