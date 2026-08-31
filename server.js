const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// Memoria para logs y cola de mensajes
let cloudLogs = [];
let messageQueue = [];
let isProcessingQueue = false;

// Simulación de envío con intervalo seguro (1 minuto / 60 segundos)
async function processMessageQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    isProcessingQueue = true;
    const currentTask = messageQueue.shift();

    try {
        console.log(`[QUEUE] 📤 Enviando mensaje a ${currentTask.telefono}... (Pausando 60s por seguridad)`);
        
        // --- AQUÍ SE CONECTARÁ TU WHATSAPP (Librería Baileys o WWebJS) ---
        // Simulamos el envío exitoso por ahora:
        await new Promise(resolve => setTimeout(resolve, 1500)); 

        const exitoLog = {
            fecha: new Date().toLocaleString(),
            nombre: currentTask.usuario || 'Cliente MediaTV',
            telefono: currentTask.telefono,
            exito: true,
            detalle: 'Enviado con éxito (Fila Cloud)'
        };

        cloudLogs.unshift(exitoLog);
        if (cloudLogs.length > 30) cloudLogs.pop();

    } catch (error) {
        console.error(`[QUEUE ERROR] ❌ Falló el envío a ${currentTask.telefono}:`, error);
        cloudLogs.unshift({
            fecha: new Date().toLocaleString(),
            nombre: currentTask.usuario || 'Error',
            telefono: currentTask.telefono,
            exito: false,
            detalle: 'Error en pasarela de WhatsApp'
        });
    } finally {
        // Pausa estricta de 60 segundos antes de procesar el siguiente mensaje
        setTimeout(() => {
            isProcessingQueue = false;
            processMessageQueue();
        }, 60000); 
    }
}

app.get('/', (req, res) => {
    res.json({ status: 'ONLINE', service: 'MediaTV Cloud Bot 24/7', queueLength: messageQueue.length });
});

// Endpoint que recibe la orden de cobro/notificación y la mete a la cola
app.post('/api/enviar-notificacion', (req, res) => {
    const { telefono, mensaje, usuario } = req.body;
    
    if (!telefono || !mensaje) {
        return res.status(400).json({ success: false, error: 'Faltan datos obligatorios' });
    }

    // Agregamos a la cola de envío
    messageQueue.push({ telefono, mensaje, usuario });
    
    // Disparamos el procesador si está inactivo
    processMessageQueue();

    res.json({ 
        success: true, 
        message: 'Mensaje agregado a la cola de la nube. Se enviará respetando el intervalo de seguridad.',
        queuePosition: messageQueue.length
    });
});

app.get('/api/logs', (req, res) => {
    res.json({ success: true, logs: cloudLogs, queueActive: messageQueue.length });
});

app.listen(PORT, () => {
    console.log(`✅ Servidor Cloud de MediaTV 4K corriendo en el puerto ${PORT}`);
});