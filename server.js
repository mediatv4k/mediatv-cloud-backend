const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// Ruta de estado para verificar que el servidor cloud está vivo 24/7
app.get('/', (req, res) => {
    res.json({ status: 'ONLINE', service: 'MediaTV Cloud Bot 24/7', timestamp: new Date() });
});

// Endpoint que recibirá las órdenes directas desde tu panel web principal en Vercel
app.post('/api/enviar-notificacion', (req, res) => {
    const { telefono, mensaje, usuario } = req.body;
    
    if (!telefono || !mensaje) {
        return res.status(400).json({ success: false, error: 'Faltan datos obligatorios (teléfono o mensaje)' });
    }

    console.log(`[CLOUD BOT] 🚀 Orden procesada para el usuario: ${usuario || 'N/A'} al Tel: ${telefono}`);
    
    // Aquí montaremos la conexión definitiva con el motor de WhatsApp en la nube
    // Por ahora, el servidor responde confirmando la recepción con éxito absoluto
    res.json({ 
        success: true, 
        message: 'Notificación recibida y en cola de envío en la nube',
        destinatario: telefono 
    });
});

app.listen(PORT, () => {
    console.log(`✅ Servidor Cloud de MediaTV 4K corriendo exitosamente en el puerto ${PORT}`);
});