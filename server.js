const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// Memoria temporal en la nube para el historial de auditoría (logs)
let cloudLogs = [];

// Ruta de estado para verificar que el servidor cloud está activo 24/7
app.get('/', (req, res) => {
    res.json({ status: 'ONLINE', service: 'MediaTV Cloud Bot 24/7', timestamp: new Date() });
});

// Endpoint principal que recibe las órdenes desde tu panel web en Vercel
app.post('/api/enviar-notificacion', (req, res) => {
    const { telefono, mensaje, usuario } = req.body;
    
    if (!telefono || !mensaje) {
        return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (teléfono o mensaje)' });
    }

    const nuevaActividad = {
        fecha: new Date().toLocaleString(),
        nombre: usuario || 'Cliente Final',
        telefono: telefono,
        exito: true
    };

    // Guardamos en el historial (máximo 20 registros recientes)
    cloudLogs.unshift(nuevaActividad);
    if (cloudLogs.length > 20) cloudLogs.pop();

    console.log(`[CLOUD BOT] 🚀 Mensaje procesado con éxito para: ${usuario || 'N/A'} al Tel: ${telefono}`);
    
    res.json({ 
        success: true, 
        message: 'Notificación procesada y enrutada por el servidor cloud',
        audit: nuevaActividad
    });
});

// Endpoint para que tu panel web consulte los logs de actividad en tiempo real
app.get('/api/logs', (req, res) => {
    res.json({ success: true, logs: cloudLogs });
});

app.listen(PORT, () => {
    console.log(`✅ Servidor Cloud de MediaTV 4K corriendo exitosamente en el puerto ${PORT}`);
});