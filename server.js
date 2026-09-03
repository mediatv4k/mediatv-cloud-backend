const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,function matchesScheduledTime(horaProg, currentHours24, currentMinutes) {
    if (!horaProg) return false;
    const clean = String(horaProg).toLowerCase().replace(/\s+/g, '').trim();
    
    // Si viene en formato de 24 horas estricto (ej: 19:00)
    if (/^\d{1,2}:\d{2}$/.test(clean)) {
        const [h, m] = clean.split(':').map(Number);
        return currentHours24 === h && currentMinutes === m;
    }
    
    // Si viene en formato de 12 horas con am/pm (ej: 08:15p.m. o 8:15pm)
    // Extraemos todos los dígitos numéricos de la cadena de texto de forma segura
    const matches = clean.match(/(\d{1,2}):(\d{2})/);
    if (matches) {
        let h = parseInt(matches[1], 10);
        const m = parseInt(matches[2], 10);
        
        // Evaluamos si contiene indicador PM (p, p.m., pm)
        const esPm = clean.includes('p');
        // Evaluamos si contiene indicador AM (a, a.m., am)
        const esAm = clean.includes('a');
        
        if (esPm && h < 12) h += 12;
        if (esAm && h === 12) h = 0;
        
        return currentHours24 === h && currentMinutes === m;
    }
    return false;
}
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
        const querySnapshot = await getDocs(collection(db, 'sessions_cloud'));
        querySnapshot.forEach(async (document) => {
            await deleteDoc(doc(db, 'sessions_cloud', document.id));
        });
    } catch (e) {}
}

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

let sock = null;
let qrImageBase64 = null;
let isConnected = false;
let cloudLogs = [];
let botInterval = null;
let ultimoMinutoProcesado = "";
let ultimoDiaProcesado = "";

function addLog(text, type = "info") {
    const timeStr = new Date().toLocaleTimeString();
    const logEntry = { time: timeStr, text, type };
    cloudLogs.unshift(logEntry);
    if (cloudLogs.length > 50) cloudLogs.pop();
}

// ==========================================
// FIREBASE FIRESTORE ADAPTER FOR BAILEYS
// ==========================================
function useFirestoreAuthState() {
    const writeData = async (data, id) => {
        try {
            const jsonStr = JSON.stringify(data, BufferJSON.replacer);
            await setDoc(doc(db, 'sessions_cloud', id), { json: jsonStr }, { merge: true });
        } catch (error) {
            console.error("Error writing auth data:", error);
        }
    };

    const readData = async (id) => {
        try {
            const docSnap = await getDoc(doc(db, 'sessions_cloud', id));
            if (docSnap.exists()) {
                const data = docSnap.data();
                return JSON.parse(data.json, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await deleteDoc(doc(db, 'sessions_cloud', id));
        } catch (error) {}
    };

    return {
        state: {
            creds: null,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = Buffer.from(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            tasks.push(writeData(value, `${category}-${id}`));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            if (sock && sock.authState && sock.authState.creds) {
                await writeData(sock.authState.creds, 'creds');
            }
        },
        readData,
        removeData
    };
}

async function startWhatsApp() {
    try {
        addLog("Iniciando motor de WhatsApp Cloud...", "info");
        const { state, saveCreds } = useFirestoreAuthState();
        let credsData = await state.keys.get('creds', ['creds']);
        if (!credsData['creds']) {
            const { creds, keys } = initAuthCreds();
            state.creds = creds;
            state.keys = keys;
            await saveCreds();
        } else {
            state.creds = credsData['creds'];
        }

        const { version } = await fetchLatestBaileysVersion();
        
        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            auth: state
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                qrImageBase64 = qr;
                addLog("📷 Nuevo Código QR Generado. Escanee desde la app.", "warning");
            }
            if (connection === 'open') {
                isConnected = true;
                qrImageBase64 = null;
                addLog("✅ ¡WhatsApp Conectado Exitosamente en la Nube!", "success");
                iniciarMotorCobranzaCloud(sock);
            }
            if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                addLog(`⚠️ Conexión cerrada (Código: ${statusCode}). Reiniciando...`, "error");
                
                if (statusCode === DisconnectReason.loggedOut) {
                    addLog("🧹 Sesión cerrada por WhatsApp. Limpiando credenciales antiguas...", "error");
                    await limpiarSesionesAntiguas();
                }
                
                setTimeout(startWhatsApp, 4000);
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (e) {
        addLog(`❌ Error crítico en WhatsApp: ${e.message}`, "error");
        setTimeout(startWhatsApp, 6000);
    }
}

function matchesScheduledTime(horaProg, currentHours24, currentMinutes) {
    if (!horaProg) return false;
    const clean = String(horaProg).toLowerCase().replace(/\s+/g, '').trim();
    
    if (/^\d{1,2}:\d{2}$/.test(clean)) {
        const [h, m] = clean.split(':').map(Number);
        return currentHours24 === h && currentMinutes === m;
    }
    
    const match = clean.match(/(\d{1,2}):(\d{2})*/);
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
            const estadoEnvioPanel = dataAdmin.estadoEnvio || "Activo";

            if (estadoEnvioPanel !== "Activo") return;

            const esHoraDeCobro = matchesScheduledTime(horaProgramadaPanel, currentHours24, minutoActual);

            if (esHoraDeCobro && ultimoMinutoProcesado !== claveMinutoUnica && ultimoDiaProcesado !== hoyStr) {
                ultimoMinutoProcesado = claveMinutoUnica;
                ultimoDiaProcesado = hoyStr; 
                
                const horaStrVE = String(currentHours24).padStart(2, '0') + ":" + String(minutoActual).padStart(2, '0');
                addLog(`🚀 [BOT] Barrido diario autorizado por el panel a las ${horaStrVE} (VE)...`, "warning");
                
                const listaClientes = dataAdmin.clientes || [];
                const hoy = new Date(horaActualVE.getFullYear(), horaActualVE.getMonth(), horaActualVE.getDate());
                let enviadosCount = 0;

                for (const client of listaClientes) {
                    const usuario = getProp(client, ['Usuario', 'usuario', 'USUARIO']);
                    if (!usuario) continue;

                    const nombre = getProp(client, ['Nombre Completo', 'nombreCompleto', 'Nombre', 'nombre', 'NOMBRE']) || 'Cliente';
                    const fechaExpStr = getProp(client, ['Fecha Expira', 'fechaExpira', 'Expira', 'expira', 'VENCIMIENTO', 'FECHA_EXPIRA']);
                    const telefono = getProp(client, ['Telefono', 'telefono', 'TELEFONO', 'Teléfono', 'CELULAR']);
                    const password = getProp(client, ['Password', 'password', 'PASSWORD', 'Contraseña', 'CONTRASEÑA']) || '********';

                    if (!fechaExpStr || !telefono) continue;

                    const expDate = parseFechaExcel(fechaExpStr);
                    if (!expDate) continue;

                    const diffTime = expDate.getTime() - hoy.getTime();
                    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

                    let enviar = false;
                    let tipoMensaje = "";

                    if (diffDays === 2) {
                        enviar = true;
                        tipoMensaje = "POR_VENCER";
                    } else if (diffDays === 0) {
                        enviar = true;
                        tipoMensaje = "VENCE_HOY";
                    } else if (diffDays >= -3 && diffDays < 0) {
                        enviar = true;
                        tipoMensaje = "VENCIDO";
                    }

                    if (enviar) {
                        let jid = String(telefono).replace(/\D/g, '');
                        if (!jid.startsWith('58')) jid = '58' + jid;
                        jid += '@s.whatsapp.net';

                        let mensaje = "";
                        // ENLACE CORREGIDO Y BLINDADO APUNTANDO A LA RAÍZ CON PARÁMETRO SEGURO
                        const linkPagoSeguro = `https://mediatv-4k.vercel.app/?user=${encodeURIComponent(usuario)}`;

                        if (tipoMensaje === "POR_VENCER" || tipoMensaje === "VENCE_HOY") {
                            const fechaFormateada = expDate.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
                            mensaje = `¡Hola ${nombre}! 👋 Te saluda el *Equipo de Soporte Técnico de MediaTV*.\n\nTe recordamos que tu servicio para el usuario (*${usuario}*) vence el ${fechaFormateada}.\n\n💳 Puedes procesar tu renovación rápida y segura aquí:\n${linkPagoSeguro}\n\n📺 *Tus Datos de Acceso (Guárdalos bien):*\n👤 *Usuario:* ${usuario}\n🔑 *Contraseña:* ${password}\n\n¡Mantén tu entretenimiento en 4K activo al instante! ✨`;
                        } else if (tipoMensaje === "VENCIDO") {
                            const diasVencido = Math.abs(diffDays);
                            const fechaFormateada = expDate.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
                            mensaje = `¡Hola ${nombre}! 👋 Te saluda el *Equipo de Soporte Técnico de MediaTV*.\n\nTe informamos que tu servicio para el usuario (*${usuario}*) venció hace ${diasVencido} día(s) (el ${fechaFormateada}). ⚠️\n\n💳 Puedes procesar tu renovación rápida y segura aquí:\n${linkPagoSeguro}\n\n📺 *Tus Datos de Acceso (Guárdalos bien):*\n👤 *Usuario:* ${usuario}\n🔑 *Contraseña:* ${password}\n\n¡Reactiva tu entretenimiento en 4K al instante! ✨`;
                        }

                        if (mensaje && whatsappClient) {
                            try {
                                await whatsappClient.sendMessage(jid, { text: mensaje });
                                enviadosCount++;
                                addLog(`📤 [ENVIADO] A ${nombre} (${usuario}) - Tipo: ${tipoMensaje}`, "success");
                                await new Promise(r => setTimeout(r, 4000));
                            } catch (errWhatsApp) {
                                addLog(`❌ Error enviando a ${usuario}: ${errWhatsApp.message}`, "error");
                            }
                        }
                    }
                }
                addLog(`🏁 [BOT] Barrido diario finalizado. Mensajes enviados hoy: ${enviadosCount}`, "success");
            }
        } catch (errCloud) {
            addLog(`❌ Error en ciclo cloud: ${errCloud.message}`, "error");
        }
    }, 60000);
}

function getProp(obj, keys) {
    if (!obj) return null;
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
            return obj[k];
        }
    }
    return null;
}

function parseFechaExcel(val) {
    if (!val) return null;
    if (typeof val === 'number') {
        const utc_days = Math.floor(val - 25569);
        const utc_value = utc_days * 86400;
        const date_info = new Date(utc_value * 1000);
        return new Date(date_info.getUTCFullYear(), date_info.getUTCMonth(), date_info.getUTCDate());
    }
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
        const [y, m, d] = str.split('-').map(Number);
        return new Date(y, m - 1, d);
    }
    if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(str)) {
        const parts = str.split(/[-/]/);
        return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    }
    const parsed = new Date(str);
    if (!isNaN(parsed.getTime())) {
        return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    }
    return null;
}

// ==========================================
// ENDPOINTS DE LA API CLOUD
// ==========================================
app.post(['/api/admin-config', '/admin-config'], async (req, res) => {
    try {
        const { horaProgramada, estadoEnvio } = req.body;
        const adminRef = doc(db, 'mediatv_data', 'admin');
        await setDoc(adminRef, { 
            horaProgramada: horaProgramada || "",
            estadoEnvio: estadoEnvio || "Activo"
        }, { merge: true });
        addLog(`⚙️ Hora configurada desde el panel: ${horaProgramada}`, "success");
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
        return res.send(`<h2 style="font-family:sans-serif;text-align:center;color:#38bdf8;margin-top:20vh;">⏳ Generando Código QR, por favor recargue en unos segundos...</h2>`);
    }
    qrcode.toDataURL(qrImageBase64, { margin: 1, width: 260 }, (err, url) => {
        if (err) {
            return res.status(500).send("Error generando QR");
        }
        res.send(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="20"></head><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#fff;"><img src="${url}" style="width:250px;height:250px;" /></body></html>`);
    });
});

app.listen(PORT, () => {
    addLog(`🚀 Servidor Cloud corriendo en el puerto ${PORT}`, "info");
    startWhatsApp();
});
